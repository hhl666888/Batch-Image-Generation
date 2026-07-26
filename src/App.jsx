import { useState, useEffect, useCallback } from 'react'
import './App.css'
import JSZip from 'jszip'

// 风格模板配置
const STYLE_TEMPLATES = {
  '日系手绘': {
    description: '日系风格，手绘质感，温暖色调，清新画风',
    color: '#f8b500'
  },
  '扁平化矢量': {
    description: '扁平化设计，矢量风格，简洁明亮，几何感强',
    color: '#00d4ff'
  },
  'Q版卡通': {
    description: 'Q版可爱，卡通风格，圆润线条，色彩鲜艳',
    color: '#ff6b6b'
  },
  '写实摄影': {
    description: '写实风格，摄影质感，高保真，细节丰富',
    color: '#4ecca3'
  }
}

// 预设尺寸选项（显示用，带中文乘号）
// 注意：API要求最小像素为3,686,400（即1920×1920），所以移除了小尺寸
const PRESET_SIZES_DISPLAY = ['1920×1920', '2048×2048', '2K', '3K', '4K']

// API要求的最小像素数：3,686,400
const MIN_PIXELS = 3686400

// 尺寸显示格式转换为API请求格式
const convertSizeToAPI = (sizeStr, customW, customH) => {
  if (sizeStr === '自定义' && customW && customH) {
    return `${customW}x${customH}`
  }
  // 把中文×替换为英文x，并且全部转小写（2K->2k）
  return sizeStr.replace('×', 'x').toLowerCase()
}

// 验证尺寸是否满足API的最小像素要求
const validateSize = (sizeStr, customW, customH) => {
  // 2K, 3K, 4K 这种预设格式API会自动处理，直接通过
  if (sizeStr === '2K' || sizeStr === '3K' || sizeStr === '4K') {
    return { valid: true, message: '' }
  }
  
  let width, height
  if (sizeStr === '自定义') {
    if (!customW || !customH) {
      return { valid: false, message: '请填写自定义尺寸的宽和高' }
    }
    width = parseInt(customW, 10)
    height = parseInt(customH, 10)
  } else {
    // 解析预设尺寸，如 1920×1920
    const parts = sizeStr.split('×')
    if (parts.length !== 2) {
      return { valid: false, message: '尺寸格式错误' }
    }
    width = parseInt(parts[0], 10)
    height = parseInt(parts[1], 10)
  }
  
  if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
    return { valid: false, message: '尺寸格式错误' }
  }
  
  const pixels = width * height
  if (pixels < MIN_PIXELS) {
    return { 
      valid: false, 
      message: `尺寸像素不足！当前 ${pixels.toLocaleString()} 像素，需要至少 ${MIN_PIXELS.toLocaleString()} 像素（如 1920×1920 或 2K）` 
    }
  }
  
  return { valid: true, message: '' }
}

// 负面提示词（固定）
const NEGATIVE_PROMPT = '畸形, 文字, 水印, 模糊, 杂乱背景'

// 清理文件名，移除Windows/Linux/Mac都不允许的字符，限制长度
const sanitizeFilename = (name, maxLength = 100) => {
  if (!name) return '未命名'
  // 移除非法字符：\ / : * ? " < > | 和控制字符
  let sanitized = name.replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
  // 替换连续空格/下划线
  sanitized = sanitized.replace(/[\s_]+/g, '_')
  // 去除首尾的点和空格（Windows保留名不允许以.结尾）
  sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, '')
  // 限制长度，避免文件名过长
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength)
  }
  return sanitized || '未命名'
}

// ===== 服务端地址配置 =====
// 后端服务同时负责：1. API代理转发（解决CORS）2. 把文件直接写入download文件夹
const BACKEND_URL = 'http://localhost:3001'
// 生图API：通过后端代理转发
const API_BASE_URL = `${BACKEND_URL}/api/v3/images/generations`
const MODEL_ID = 'doubao-seedream-5-0-260128'

function App() {
  // 状态管理
  const [apiKey, setApiKey] = useState('')
  const [themes, setThemes] = useState('')
  const [selectedStyle, setSelectedStyle] = useState('日系手绘')
  const [customPrompt, setCustomPrompt] = useState('')
  // 默认使用 2K，满足API最小像素要求
  const [size, setSize] = useState('2K')
  const [customWidth, setCustomWidth] = useState('')
  const [customHeight, setCustomHeight] = useState('')
  const [format, setFormat] = useState('png')
  const [generatedImages, setGeneratedImages] = useState([])
  const [loading, setLoading] = useState(false)
  const [generatingIndices, setGeneratingIndices] = useState([])
  const [buttonDisabled, setButtonDisabled] = useState(false)
  const [error, setError] = useState('')
  const [fullPrompt, setFullPrompt] = useState('')
  // 后端服务健康状态（关键！现在所有请求都走后端3001端口）
  const [backendOnline, setBackendOnline] = useState(null)
  // ========= 下载状态 =========
  // 正在下载的图片ID集合（单张下载loading按钮用）
  const [downloadingImageIds, setDownloadingImageIds] = useState(new Set())
  // 批量打包下载loading
  const [batchDownloading, setBatchDownloading] = useState(false)
  // Toast通知列表（右下角弹出提示）
  const [toasts, setToasts] = useState([])

  // 页面初始化：从localStorage读取数据 + 检测后端服务是否启动
  useEffect(() => {
    const savedThemes = localStorage.getItem('batchImg_themes') || ''
    const savedStyle = localStorage.getItem('batchImg_style') || '日系手绘'
    const savedCustomPrompt = localStorage.getItem('batchImg_customPrompt') || ''
    const savedSize = localStorage.getItem('batchImg_size') || '2K'
    const savedFormat = localStorage.getItem('batchImg_format') || 'png'

    setThemes(savedThemes)
    setSelectedStyle(savedStyle)
    setCustomPrompt(savedCustomPrompt)
    setSize(savedSize)
    setFormat(savedFormat)

    // 检测后端3001端口是否在线
    checkBackendHealth()
    // 每15秒重检一次，方便用户启动后端后自动恢复
    const timer = setInterval(checkBackendHealth, 15000)
    return () => clearInterval(timer)
  }, [])

  // 检测后端服务健康状态
  const checkBackendHealth = async () => {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      const resp = await fetch(`${BACKEND_URL}/health`, { signal: controller.signal })
      clearTimeout(timeoutId)
      if (resp.ok) {
        setBackendOnline(true)
      } else {
        setBackendOnline(false)
      }
    } catch (err) {
      setBackendOnline(false)
    }
  }

  // =============== Toast 通知 ===============
  // 添加一条 Toast 通知（右下角弹出）
  const showToast = (type, title, detail = '') => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, type, title, detail }])
    // 4秒自动消失
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 4500)
  }
  // 短名
  const toastSuccess = (title, detail) => showToast('success', title, detail)
  const toastError = (title, detail) => showToast('error', title, detail)
  const toastWarn = (title, detail) => showToast('warning', title, detail)

  // 带超时的fetch（10秒超时，避免一直卡住没反应）
  const fetchWithTimeout = (url, options = {}, timeoutMs = 10000) => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    return fetch(url, { ...options, signal: controller.signal })
      .then(resp => {
        clearTimeout(timeoutId)
        return resp
      })
      .catch(err => {
        clearTimeout(timeoutId)
        if (err.name === 'AbortError') {
          throw new Error(`请求超时（${timeoutMs/1000}秒无响应），请检查后端服务是否运行`)
        }
        throw err
      })
  }

  // 自动更新完整Prompt预览
  useEffect(() => {
    updateFullPrompt()
  }, [themes, selectedStyle, customPrompt, size, customWidth, customHeight])

  // 保存到localStorage的回调函数
  const saveToLocalStorage = useCallback((key, value) => {
    localStorage.setItem(key, value)
  }, [])

  // 更新完整Prompt
  const updateFullPrompt = () => {
    const themeList = themes.split('\n').filter(t => t.trim())
    if (themeList.length === 0) {
      setFullPrompt('')
      return
    }

    const firstTheme = themeList[0].trim()
    const styleDesc = STYLE_TEMPLATES[selectedStyle]?.description || ''
    
    let sizeDesc = size
    if (size === '自定义' && customWidth && customHeight) {
      sizeDesc = `${customWidth}×${customHeight}`
    }

    const promptParts = [
      firstTheme,
      styleDesc,
      customPrompt,
      `尺寸: ${sizeDesc}`,
      `负面词: ${NEGATIVE_PROMPT}`
    ].filter(part => part.trim())

    setFullPrompt(promptParts.join(', '))
  }

  // 清空主题
  const clearThemes = () => {
    setThemes('')
    saveToLocalStorage('batchImg_themes', '')
  }

  // 复制主题
  const copyThemes = async () => {
    try {
      await navigator.clipboard.writeText(themes)
      alert('主题已复制到剪贴板！')
    } catch (err) {
      console.error('复制失败:', err)
      alert('复制失败，请手动复制')
    }
  }

  // 节流函数
  const throttle = (func, delay) => {
    let lastCall = 0
    return function(...args) {
      const now = Date.now()
      if (now - lastCall >= delay) {
        lastCall = now
        return func.apply(this, args)
      }
    }
  }

  // 生成单张图片
  const generateSingleImage = async (theme, index, retryCount = 0) => {
    const styleDesc = STYLE_TEMPLATES[selectedStyle]?.description || ''
    
    const requestSize = convertSizeToAPI(size, customWidth, customHeight)

    const promptParts = [
      theme.trim(),
      styleDesc,
      customPrompt
    ].filter(part => part.trim())

    const finalPrompt = promptParts.join(', ')

    try {
      const response = await fetch(API_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: MODEL_ID,
          prompt: finalPrompt,
          size: requestSize,
          response_format: 'url',
          sequential_image_generation: 'disabled',
          stream: false,
          watermark: true
        })
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error?.message || `请求失败: ${response.status}`)
      }

      const data = await response.json()
      
      if (data.data && data.data[0] && data.data[0].url) {
        return {
          index,
          success: true,
          url: data.data[0].url,
          prompt: finalPrompt,
          theme: theme.trim()
        }
      } else {
        throw new Error('API返回格式异常')
      }
    } catch (err) {
      // 增强错误处理：把通用的 Failed to fetch 转换为更可读的提示
      let errorMsg = err.message || '生成失败'
      if (errorMsg === 'Failed to fetch' || errorMsg.includes('NetworkError') || err.name === 'TypeError') {
        // 现在请求都走 localhost:3001 后端代理，Failed to fetch 99% 是后端没启动
        errorMsg = '❌ 后端服务未启动！请在项目根目录新开终端运行：npm run server    （启动后端后，生图、下载到download文件夹才能使用）'
      }
      
      if (retryCount < 2) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        return generateSingleImage(theme, index, retryCount + 1)
      }
      return {
        index,
        success: false,
        error: errorMsg,
        theme: theme.trim()
      }
    }
  }

  // 批量生成图片（并发控制）
  const generateImages = throttle(async () => {
    if (!apiKey.trim()) {
      setError('请先输入API Key')
      return
    }

    const themeList = themes.split('\n').filter(t => t.trim())
    if (themeList.length === 0) {
      setError('请至少输入一个生成主题')
      return
    }

    // 验证尺寸是否符合API要求
    const sizeValidation = validateSize(size, customWidth, customHeight)
    if (!sizeValidation.valid) {
      setError(sizeValidation.message)
      return
    }

    setLoading(true)
    setButtonDisabled(true)
    setError('')
    setGeneratingIndices(themeList.map((_, i) => i))

    const results = []
    const maxConcurrency = 3
    let currentIndex = 0

    // 并发控制器
    const processBatch = async () => {
      while (currentIndex < themeList.length) {
        const batch = []
        for (let i = 0; i < maxConcurrency && currentIndex < themeList.length; i++, currentIndex++) {
          batch.push(generateSingleImage(themeList[currentIndex], currentIndex))
        }
        const batchResults = await Promise.all(batch)
        results.push(...batchResults)
      }
    }

    await processBatch()

    // 更新结果
    const newImages = results.sort((a, b) => a.index - b.index).map((result, idx) => ({
      id: Date.now() + idx,
      ...result
    }))

    setGeneratedImages(newImages)
    setLoading(false)
    setGeneratingIndices([])

    setTimeout(() => {
      setButtonDisabled(false)
    }, 3000)
  }, 3000)

  // 单张重新生成
  const regenerateImage = async (index, theme) => {
    // 验证尺寸是否符合API要求
    const sizeValidation = validateSize(size, customWidth, customHeight)
    if (!sizeValidation.valid) {
      setError(sizeValidation.message)
      return
    }
    
    setGeneratingIndices(prev => [...prev, index])
    
    const result = await generateSingleImage(theme, index)
    
    setGeneratedImages(prev => prev.map((img, i) => 
      i === index ? { ...img, ...result, id: Date.now() } : img
    ))
    
    setGeneratingIndices(prev => prev.filter(i => i !== index))
  }

  // 通过canvas跨域获取图片blob（解决CORS问题）
  const fetchImageAsBlob = (imageUrl) => {
    return new Promise((resolve, reject) => {
      const img = new Image()
      // 设置匿名跨域
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          const ctx = canvas.getContext('2d')
          ctx.drawImage(img, 0, 0)
          // 转成blob
          canvas.toBlob((blob) => {
            if (blob) {
              resolve(blob)
            } else {
              // toBlob失败，退回到直接创建a标签的方式
              reject(new Error('canvas转换失败'))
            }
          }, `image/${format === 'jpg' ? 'jpeg' : format}`, 0.95)
        } catch (err) {
          reject(err)
        }
      }
      img.onerror = (e) => {
        // 图片加载失败，也尝试直接下载
        reject(new Error('图片加载失败'))
      }
      img.src = imageUrl
      // 缓存中图片的处理
      if (img.complete) {
        img.onload()
      }
    })
  }

  // ============ 终极方案：后端自己下载图片URL，彻底无CORS ============
  // 前端只传 URL + 文件名 JSON，后端 axios 下载，100%成功

  // 单张图片：传 imageUrl + filename + format 给后端 /save-image 接口（JSON）
  // 后端自己去下载图片URL → 保存到 download 文件夹
  const downloadImage = async (imageUrl, themeName, imgId = null) => {
    const cleanName = sanitizeFilename(themeName)
    const ext = format === 'jpg' ? 'jpg' : format
    const filename = `${cleanName}.${ext}`

    console.log(`[下载] 开始: ${filename} → 后端模式(无CORS)，URL: ${imageUrl.slice(0, 80)}...`)

    // 标记当前这张图为「下载中」，按钮显示loading
    if (imgId !== null) {
      setDownloadingImageIds(prev => new Set(prev).add(imgId))
    }

    try {
      setError(`正在让后端下载【${cleanName}】并保存到 download 文件夹...`)

      // 发 JSON，后端自己 axios 下载（后端没CORS限制）
      const resp = await fetchWithTimeout(
        `${BACKEND_URL}/save-image`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageUrl: imageUrl,
            filename: filename,
            format: format
          })
        },
        45000  // 单图最长45秒（后端下载+写入）
      )
      const result = await resp.json()
      if (result.success) {
        console.log(`[下载] ✅ 后端保存成功: ${result.filename} (${result.sizeKB || '?'} KB)`)
        toastSuccess(
          `💾 已保存到 download 文件夹`,
          `${result.filename}  (${(result.sizeKB || 0).toFixed(1)} KB)`
        )
        setError('')
      } else {
        throw new Error(result.message || '后端保存失败')
      }
    } catch (err) {
      console.error('[下载] 通过后端保存失败:', err)
      const isNetworkError = err.message === 'Failed to fetch' || err.message.includes('NetworkError') || err.name === 'TypeError'
      // ===== 兜底：前端使用 Blob + <a download> 方式直接下载 =====
      try {
        const fullFilename = `${cleanName}.${ext}`
        console.log(`[下载] 兜底：前端直接下载 → ${fullFilename}`)
        
        const response = await fetch(imageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        })
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fullFilename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)

        if (isNetworkError) {
          toastWarn(
            `🌐 后端未连接：已通过浏览器直接下载`,
            `已下载：${fullFilename}。请在项目根目录运行「npm run server」启动后端，以获得更好的下载体验`
          )
        } else {
          toastWarn(
            `📸 后端保存失败：已通过浏览器直接下载`,
            `已下载：${fullFilename}。请查看后端终端日志，修复后重新点击保存`
          )
        }
      } catch (err2) {
        console.error('[下载] ❌ 兜底也失败，给提示:', err2)
        // 最后兜底：新标签页打开
        const fullFilename = `${cleanName}.${ext}`
        try {
          const a = document.createElement('a')
          a.href = imageUrl
          a.download = fullFilename
          a.target = '_blank'
          a.rel = 'noopener noreferrer'
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
        } catch (err3) {
          console.error('[下载] ❌ 新标签页打开也失败:', err3)
        }
        toastError(
          `❌ 下载失败`,
          `${err.message || err2.message || '未知错误'}。请确认后端已启动，或直接右键图片另存为`
        )
      }
    } finally {
      // 取消loading按钮
      if (imgId !== null) {
        setDownloadingImageIds(prev => {
          const s = new Set(prev)
          s.delete(imgId)
          return s
        })
      }
    }
  }

  // 批量打包：传 URL+文件名 数组 + format 给后端，后端下载+JSZip打包
  const downloadAllImages = async () => {
    const successImages = generatedImages.filter(img => img.success)
    if (successImages.length === 0) {
      toastWarn('没有可下载的图片', '请先生成图片')
      return
    }
    console.log(`[批量打包] 开始：共 ${successImages.length} 张 → 后端模式(无CORS)`)
    setBatchDownloading(true)
    setError(`正在让后端批量下载 ${successImages.length} 张图片并打包...`)

    try {
      const ext = format === 'jpg' ? 'jpg' : format
      // 构造 items：{url, filename} 数组，用主题名做文件名，带格式后缀
      const usedFilenames = new Map()
      const items = successImages.map(img => {
        let cleanName = sanitizeFilename(img.theme)
        // 前端先处理一次重名，后端也会再处理
        if (usedFilenames.has(cleanName)) {
          const count = usedFilenames.get(cleanName) + 1
          usedFilenames.set(cleanName, count)
          cleanName = `${cleanName}_${count}`
        } else {
          usedFilenames.set(cleanName, 1)
        }
        return { url: img.url, filename: `${cleanName}.${ext}` }
      })

      const zipFilename = `批量生图_${Date.now()}.zip`

      // POST JSON 到 save-zip-from-urls，后端自己下载打包
      // 超时 = 每张图预估30秒 + 打包10秒
      const timeout = Math.max(120000, successImages.length * 30000 + 20000)
      const resp = await fetchWithTimeout(
        `${BACKEND_URL}/save-zip-from-urls`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, zipFilename, format: format })
        },
        timeout
      )
      const result = await resp.json()
      if (result.success) {
        console.log(`[批量打包] ✅ 后端保存成功: ${result.filename} (${result.sizeMB || '?'} MB), 成功${result.successCount}张/失败${result.failCount}张`)
        toastSuccess(
          `📦 批量打包成功（${result.successCount}张）`,
          `已保存: download/${result.filename}  (${(result.sizeMB || 0).toFixed(2)} MB)${result.failCount > 0 ? `，失败 ${result.failCount} 张` : ''}`
        )
        setError('')
      } else {
        throw new Error(result.message || '后端打包失败')
      }
    } catch (err) {
      console.error('[批量打包] 后端保存失败:', err)
      // 区分网络错误（后端没启动）和 后端返回的业务错误，给出更明确的提示
      const isNetworkError = err.message === 'Failed to fetch' || err.message.includes('NetworkError') || err.name === 'TypeError'

      // 兜底：前端使用 JSZip + Blob + <a download> 方式直接打包下载
      try {
        const ext = format === 'jpg' ? 'jpg' : format
        const zip = new JSZip()
        const downloadedCount = { success: 0, fail: 0 }

        // 并行下载图片
        const downloadPromises = successImages.map(async (img) => {
          try {
            const response = await fetch(img.url, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
              }
            })
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`)
            }
            const blob = await response.blob()
            downloadedCount.success++
            return { img, blob }
          } catch (err) {
            downloadedCount.fail++
            console.error(`[批量打包] 下载失败: ${img.theme}`, err)
            return { img, error: err }
          }
        })

        const results = await Promise.all(downloadPromises)

        // 添加到 zip
        const zipUsedNames = new Map()
        results.forEach(res => {
          if (res.blob) {
            let cleanName = sanitizeFilename(res.img.theme)
            const base = cleanName
            if (zipUsedNames.has(base)) {
              const c = zipUsedNames.get(base) + 1
              zipUsedNames.set(base, c)
              cleanName = `${base}_${c}`
            } else {
              zipUsedNames.set(base, 1)
            }
            zip.file(`${cleanName}.${ext}`, res.blob)
          }
        })

        // 生成 zip 并下载
        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
        const url = URL.createObjectURL(zipBlob)
        const a = document.createElement('a')
        a.href = url
        a.download = `批量生图_${Date.now()}.zip`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)

        if (isNetworkError) {
          toastWarn(
            `🌐 后端未连接：已通过浏览器直接打包下载`,
            `已下载：${downloadedCount.success} 张，失败 ${downloadedCount.fail} 张。请在项目根目录运行「npm run server」启动后端，以获得更好的下载体验`
          )
        } else {
          toastWarn(
            `📦 后端保存失败：已通过浏览器直接打包下载`,
            `已下载：${downloadedCount.success} 张，失败 ${downloadedCount.fail} 张。请查看后端终端日志，修复后重新点击批量保存`
          )
        }
      } catch (err2) {
        console.error('[批量打包] 前端打包也失败:', err2)
        // 最后兜底：逐个在新标签打开图片
        try {
          for (let i = 0; i < successImages.length; i++) {
            const img = successImages[i]
            const cleanName = sanitizeFilename(img.theme)
            const a = document.createElement('a')
            a.href = img.url
            a.download = `${cleanName}.${format}`
            a.target = '_blank'
            a.rel = 'noopener noreferrer'
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            await new Promise(r => setTimeout(r, 200))
          }
        } catch (err3) {
          console.error('[批量打包] 新标签页打开也失败:', err3)
        }
        toastError(
          `❌ 打包失败`,
          `${err.message || err2.message || '未知错误'}。请确认后端服务已启动`
        )
      }
    } finally {
      setBatchDownloading(false)
    }
  }

  // 处理尺寸变更
  const handleSizeChange = (newSize) => {
    setSize(newSize)
    saveToLocalStorage('batchImg_size', newSize)
  }

  return (
    <div className="app" style={{ '--accent-color': STYLE_TEMPLATES[selectedStyle]?.color }}>
      <div className="container">
        <h1 className="title">批量AI生图工具</h1>

        {/* 后端服务状态条 - 非常醒目 */}
        {backendOnline === false && (
          <div style={{
            padding: '16px 20px',
            marginBottom: '24px',
            borderRadius: '12px',
            background: 'linear-gradient(135deg, #fff5f5 0%, #ffe0e0 100%)',
            border: '2px solid #f56565',
            color: '#c53030',
            fontSize: '15px',
            fontWeight: '500',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '16px'
          }}>
            <div>
              <div style={{ fontSize: '18px', fontWeight: '700', marginBottom: '6px' }}>
                ⚠️ 后端服务未启动
              </div>
              <div>本工具所有功能都需要本地后端支持！请打开一个新的 PowerShell / 终端窗口，运行：</div>
              <div style={{
                marginTop: '10px',
                background: 'rgba(0,0,0,0.06)',
                padding: '8px 12px',
                borderRadius: '6px',
                fontFamily: 'Consolas, monospace',
                display: 'inline-block',
                color: '#2d3748'
              }}>
                cd d:\批量生图max版本 ; npm run server
              </div>
              <div style={{ marginTop: '8px', fontSize: '13px', opacity: 0.85 }}>
                启动后端后，才可以正常生图、下载图片到 download 文件夹
              </div>
            </div>
            <button
              onClick={checkBackendHealth}
              style={{
                padding: '6px 14px',
                background: 'white',
                border: '1px solid #f56565',
                color: '#c53030',
                borderRadius: '8px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                fontSize: '13px'
              }}
            >
              刷新检测
            </button>
          </div>
        )}

        {backendOnline === true && (
          <div style={{
            padding: '14px 20px',
            marginBottom: '24px',
            borderRadius: '12px',
            background: 'linear-gradient(135deg, #f0fff4 0%, #c6f6d5 100%)',
            border: '2px solid #48bb78',
            color: '#22543d',
            fontSize: '14px',
            fontWeight: '500',
            display: 'flex',
            alignItems: 'center',
            gap: '12px'
          }}>
            <span style={{ fontSize: '20px' }}>✅</span>
            <div>
              <span style={{ fontWeight: '700' }}>后端服务正常运行中（端口3001）</span>
              <span style={{ marginLeft: '8px', opacity: 0.8 }}>
                生图结果和下载的图片将直接保存到项目根目录\download文件夹
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="error-message">
            {error}
            <button onClick={() => setError('')} className="close-error">×</button>
          </div>
        )}

        {/* API Key输入 */}
        <div className="section">
          <label className="label">API Key</label>
          <input
            type="password"
            className="input"
            placeholder="请输入API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>

        {/* 批量主题输入 */}
        <div className="section">
          <div className="label-row">
            <label className="label">批量主题（每行一张）</label>
            <div className="action-buttons">
              <button onClick={clearThemes} className="secondary-btn">清空</button>
              <button onClick={copyThemes} className="secondary-btn">复制</button>
            </div>
          </div>
          <textarea
            className="textarea"
            placeholder="请输入主题，每行一张图片的主题..."
            value={themes}
            onChange={(e) => {
              setThemes(e.target.value)
              saveToLocalStorage('batchImg_themes', e.target.value)
            }}
            rows={6}
          />
        </div>

        {/* 风格模块 */}
        <div className="section">
          <label className="label">风格选择</label>
          <div className="style-grid">
            {Object.keys(STYLE_TEMPLATES).map(style => (
              <button
                key={style}
                className={`style-btn ${selectedStyle === style ? 'active' : ''}`}
                onClick={() => {
                  setSelectedStyle(style)
                  saveToLocalStorage('batchImg_style', style)
                }}
              >
                {style}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="input"
            placeholder="自定义正向提示词（可选）"
            value={customPrompt}
            onChange={(e) => {
              setCustomPrompt(e.target.value)
              saveToLocalStorage('batchImg_customPrompt', e.target.value)
            }}
            style={{ marginTop: '12px' }}
          />
          <div className="negative-prompt">
            <strong>负面词：</strong>{NEGATIVE_PROMPT}
          </div>
        </div>

        {/* 图像参数设置 */}
        <div className="section">
          <label className="label">图像参数</label>
          <div className="params-grid">
            <div>
              <label className="sub-label">尺寸</label>
              <select
                className="select"
                value={size}
                onChange={(e) => handleSizeChange(e.target.value)}
              >
                {PRESET_SIZES_DISPLAY.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
                <option value="自定义">自定义</option>
              </select>
              {size === '自定义' && (
                <div className="custom-size">
                  <input
                    type="number"
                    placeholder="宽"
                    value={customWidth}
                    onChange={(e) => setCustomWidth(e.target.value)}
                    className="input small"
                  />
                  <span>×</span>
                  <input
                    type="number"
                    placeholder="高"
                    value={customHeight}
                    onChange={(e) => setCustomHeight(e.target.value)}
                    className="input small"
                  />
                </div>
              )}
            </div>
            <div>
              <label className="sub-label">输出格式</label>
              <select
                className="select"
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value)
                  saveToLocalStorage('batchImg_format', e.target.value)
                }}
              >
                <option value="png">PNG</option>
                <option value="jpg">JPG</option>
                <option value="webp">WebP</option>
              </select>
            </div>
          </div>
        </div>

        {/* 预览区 */}
        <div className="section">
          <label className="label">完整Prompt预览（可手动编辑）</label>
          <textarea
            className="textarea"
            value={fullPrompt}
            onChange={(e) => setFullPrompt(e.target.value)}
            rows={4}
          />
        </div>

        {/* 生成控制 */}
        <div className="generate-section">
          <button
            className="generate-btn"
            onClick={generateImages}
            disabled={loading || buttonDisabled}
          >
            {loading ? '生成中...' : buttonDisabled ? '请稍候...' : '批量生成'}
          </button>
        </div>

        {/* 结果展示区 */}
        {generatedImages.length > 0 && (
          <div className="section">
            <div className="label-row">
              <label className="label">生成结果</label>
              <button
                onClick={downloadAllImages}
                className="secondary-btn"
                disabled={batchDownloading}
              >
                {batchDownloading ? (
                  <><span className="inline-spinner"></span>打包保存中</>
                ) : (
                  '📦 批量打包保存到download文件夹'
                )}
              </button>
            </div>
            <div className="image-grid">
              {generatedImages.map((img, idx) => (
                <div key={img.id} className="image-card">
                  {generatingIndices.includes(idx) ? (
                    <div className="loading-card">
                      <div className="spinner"></div>
                      <p>生成中...</p>
                    </div>
                  ) : img.success ? (
                    <>
                      <img src={img.url} alt={img.theme} className="preview-img" />
                      <div className="card-footer">
                        <p className="img-prompt" title={img.prompt}>{img.prompt}</p>
                        <div className="card-buttons">
                          <button
                            onClick={() => regenerateImage(idx, img.theme)}
                            className="secondary-btn small"
                          >
                            🔄 重新生成
                          </button>
                          <button
                            onClick={() => downloadImage(img.url, img.theme, img.id)}
                            className="secondary-btn small"
                            disabled={downloadingImageIds.has(img.id)}
                          >
                            {downloadingImageIds.has(img.id) ? (
                              <><span className="inline-spinner"></span>保存中</>
                            ) : (
                              '💾 保存到download文件夹'
                            )}
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="error-card">
                      <p className="error-text">生成失败</p>
                      <p className="error-detail">{img.error}</p>
                      <button
                        onClick={() => regenerateImage(idx, img.theme)}
                        className="secondary-btn small"
                      >
                        🔄 重试重新生成
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ========= Toast 通知（右下角） ========= */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <div className="toast-title">{t.title}</div>
            {t.detail && <div className="toast-detail">{t.detail}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
