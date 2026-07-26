/**
 * 本地后端服务
 * 功能1：代理火山方舟API，解决前端跨域CORS问题
 * 功能2：（推荐）前端传图片URL，后端自己下载保存到 download 文件夹（完全无CORS问题）
 * 功能3：（推荐）前端传图片URL数组，后端下载+JSZip打包，zip保存到 download 文件夹
 * 功能4（兼容）：接收前端上传的图片/ZIP文件，直接写入download文件夹
 */

const express = require('express')
const multer = require('multer')
const cors = require('cors')
const axios = require('axios')
const path = require('path')
const fs = require('fs')
const JSZip = require('jszip')
const sharp = require('sharp')

const app = express()
const PORT = 3001

// 确保 download 文件夹存在
const DOWNLOAD_DIR = path.join(__dirname, 'download')
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
  console.log(`[初始化] 已创建下载目录: ${DOWNLOAD_DIR}`)
}

// =========================================
// 工具函数
// =========================================

// 清理文件名中的非法字符（跨平台）
function sanitizeFilename(name) {
  if (!name) return '未命名'
  let n = String(name)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/[\s_]+/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  if (n.length > 120) n = n.slice(0, 120)
  return n || '未命名'
}

// 处理文件名重复：在后面加 (2)(3) 等
function getSafeFileName(dir, originalName) {
  const ext = path.extname(originalName)
  const baseName = path.basename(originalName, ext)
  let safeName = originalName
  let counter = 2
  while (fs.existsSync(path.join(dir, safeName))) {
    safeName = `${baseName}(${counter})${ext}`
    counter++
  }
  return safeName
}

// 后端自己用 axios 下载图片 URL，返回 Buffer（无CORS限制）
async function downloadUrlToBuffer(imageUrl, timeoutMs = 30000) {
  if (!imageUrl) throw new Error('imageUrl不能为空')
  console.log(`  → 下载图片URL: ${imageUrl.slice(0, 90)}${imageUrl.length > 90 ? '...' : ''}`)
  const resp = await axios({
    method: 'GET',
    url: imageUrl,
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    // 模拟浏览器UA，避免部分CDN拦截
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    validateStatus: (status) => status >= 200 && status < 400
  })
  return Buffer.from(resp.data)
}

// 根据URL或Buffer推断图片扩展名
function guessImageExt(imageUrl, buffer = null) {
  // 优先从URL后缀判断
  const urlLower = (imageUrl || '').toLowerCase().split('?')[0]
  if (urlLower.endsWith('.png')) return '.png'
  if (urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg')) return '.jpg'
  if (urlLower.endsWith('.webp')) return '.webp'
  if (urlLower.endsWith('.gif')) return '.gif'
  // 兜底从buffer魔数判断
  if (buffer && buffer.length >= 4) {
    const b = buffer
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png' // PNG
    if (b[0] === 0xff && b[1] === 0xd8) return '.jpg' // JPEG
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return '.webp' // RIFF -> WebP
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif' // GIF
  }
  return '.png' // 兜底用PNG
}

// 根据目标格式转换图片Buffer
async function convertImageFormat(buffer, targetFormat) {
  if (!targetFormat || targetFormat === 'original') {
    return buffer
  }
  
  try {
    const format = targetFormat.toLowerCase()
    if (format === 'png') {
      return await sharp(buffer).png().toBuffer()
    } else if (format === 'jpg' || format === 'jpeg') {
      return await sharp(buffer).jpeg({ quality: 95 }).toBuffer()
    } else if (format === 'webp') {
      return await sharp(buffer).webp({ quality: 95 }).toBuffer()
    } else {
      return buffer
    }
  } catch (err) {
    console.error('[图片格式转换失败]:', err.message)
    return buffer
  }
}

// 根据格式获取文件扩展名
function getExtFromFormat(format) {
  if (!format) return '.png'
  const f = format.toLowerCase()
  if (f === 'jpg' || f === 'jpeg') return '.jpg'
  if (f === 'webp') return '.webp'
  return '.png'
}

// 启用CORS（允许前端Vite开发服务器访问）
app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// 【全局日志中间件】每次收到请求都打印一条，方便用户确认后端确实在工作
app.use((req, res, next) => {
  const now = new Date()
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  console.log(`[${timeStr}] ← 收到请求 ${req.method} ${req.url}`)
  next()
})

// ========== 功能1：代理火山方舟API ==========
// 前端请求 /api/xxx -> 本服务转发 -> https://ark.cn-beijing.volces.com/api/xxx
app.use('/api', async (req, res) => {
  try {
    const targetUrl = `https://ark.cn-beijing.volces.com/api${req.url}`
    console.log(`  → 正在转发API请求至: ${targetUrl}`)

    const axiosConfig = {
      method: req.method,
      url: targetUrl,
      headers: {
        // 把前端的请求头（特别是 Authorization）原样转发
        ...req.headers,
        // 删除host头，避免被目标服务器拒绝
        host: undefined,
        // 使用正确的host
        Host: 'ark.cn-beijing.volces.com'
      },
      // 超时时间60秒（生图可能比较慢）
      timeout: 60000,
      validateStatus: () => true // 不过滤状态码，原样返回
    }

    // 如果有请求体也转发
    if (req.method !== 'GET' && Object.keys(req.body).length > 0) {
      axiosConfig.data = req.body
    }

    const response = await axios(axiosConfig)
    const now = new Date()
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    console.log(`[${timeStr}] → API代理返回 HTTP${response.status}`)
    res.status(response.status).json(response.data)
  } catch (err) {
    console.error('[API代理错误]:', err.message)
    res.status(500).json({
      error: {
        message: `代理请求失败: ${err.message}`
      }
    })
  }
})

// ========== 功能2 & 3：文件保存配置 ==========
// 处理文件名重复：在后面加 (2)(3) 等
function getSafeFileName(dir, originalName) {
  const ext = path.extname(originalName)
  const baseName = path.basename(originalName, ext)
  let safeName = originalName
  let counter = 2
  while (fs.existsSync(path.join(dir, safeName))) {
    safeName = `${baseName}(${counter})${ext}`
    counter++
  }
  return safeName
}

// ========== 功能2（推荐）：前端传图片URL，后端自己下载保存 ==============
// 前端直接 POST JSON: { imageUrl: "https://xxx/xx.png", filename: "主题名.png", format: "png/jpg/webp" }
// 后端 axios 下载图片，无任何 CORS 限制，100% 成功
app.post('/save-image', async (req, res, next) => {
  // 判断 Content-Type，如果是 JSON，走推荐的 URL 模式
  const contentType = req.headers['content-type'] || ''
  if (contentType.includes('application/json')) {
    try {
      const { imageUrl, filename, format } = req.body || {}
      if (!imageUrl) {
        return res.status(400).json({ success: false, message: '缺少 imageUrl 参数' })
      }

      // 1. 清理文件名
      let safeName = sanitizeFilename(filename || '')

      // 2. 后端 axios 自己下载图片（无跨域问题！）
      let buffer = await downloadUrlToBuffer(imageUrl, 30000)

      // 3. 根据指定格式转换图片
      if (format && format !== 'original') {
        buffer = await convertImageFormat(buffer, format)
      }

      // 4. 确保文件名有正确的后缀
      const targetExt = format ? getExtFromFormat(format) : guessImageExt(imageUrl, buffer)
      const currentExt = path.extname(safeName)
      if (!currentExt) {
        safeName += targetExt
      } else if (format && format !== 'original') {
        safeName = safeName.replace(new RegExp(`${currentExt}$`), targetExt)
      }

      // 5. 处理重名
      const finalFileName = getSafeFileName(DOWNLOAD_DIR, safeName)
      const savePath = path.join(DOWNLOAD_DIR, finalFileName)

      // 6. 写入
      fs.writeFileSync(savePath, buffer)

      const sizeKB = (buffer.length / 1024).toFixed(1)
      console.log(`[图片已保存] ${finalFileName}  (${sizeKB} KB)  →  ${DOWNLOAD_DIR}`, format ? `(格式: ${format})` : '')
      return res.json({
        success: true,
        message: '保存成功',
        filename: finalFileName,
        savePath: savePath,
        sizeKB: Number(sizeKB)
      })
    } catch (err) {
      console.error('[save-image URL模式失败]:', err.message)
      return res.status(500).json({
        success: false,
        message: `保存失败: ${err.message}`
      })
    }
  }
  // 如果不是 JSON，交给后面的 multer 中间件处理（兼容旧模式）
  next()
})

// ========== 功能2（兼容模式）：前端上传文件，后端保存 ==========
// multer内存存储（文件不大，图片一般几MB）
const storage = multer.memoryStorage()
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
})

app.post('/save-image', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '没有收到图片文件，请改用 imageUrl JSON 模式' })
    }
    let safeName = sanitizeFilename(req.query.filename || req.body.filename || req.file.originalname)
    if (!path.extname(safeName)) {
      const mimeExtMap = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }
      safeName += mimeExtMap[req.file.mimetype] || '.png'
    }
    const finalFileName = getSafeFileName(DOWNLOAD_DIR, safeName)
    const savePath = path.join(DOWNLOAD_DIR, finalFileName)
    fs.writeFileSync(savePath, req.file.buffer)
    const sizeKB = (req.file.size / 1024).toFixed(1)
    console.log(`[图片已保存(上传模式)] ${finalFileName}  (${sizeKB} KB)`)
    res.json({ success: true, message: '保存成功', filename: finalFileName, savePath, sizeKB: Number(sizeKB) })
  } catch (err) {
    console.error('[save-image上传模式失败]:', err)
    res.status(500).json({ success: false, message: `保存失败: ${err.message}` })
  }
})

// ========== 功能3（推荐）：前端传URL数组，后端批量下载+JSZip打包 ==========
// POST JSON: { items: [{url, filename}], zipFilename: '批量生图_xxx.zip', format: 'png/jpg/webp' }
// 每张图的并发限制为 3 张，防止网络限流
app.post('/save-zip-from-urls', async (req, res) => {
  try {
    const { items, zipFilename, format } = req.body || {}
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: '缺少 items 数组' })
    }
    console.log(`[批量打包ZIP] 收到 ${items.length} 张图片，开始后端下载+打包...`, format ? `(目标格式: ${format})` : '')

    // 1. 下载图片（限制并发3个）
    const MAX_CONCURRENT = 3
    const downloaded = new Array(items.length).fill(null)
    let cursor = 0

    async function worker(workerId) {
      while (true) {
        const idx = cursor++
        if (idx >= items.length) return
        const item = items[idx]
        try {
          // 清理文件名 + 确保有后缀
          let safeName = sanitizeFilename(item.filename || `图片${idx + 1}`)
          
          // 下载图片
          let buffer = await downloadUrlToBuffer(item.url, 30000)
          
          // 根据指定格式转换图片
          if (format && format !== 'original') {
            buffer = await convertImageFormat(buffer, format)
          }
          
          // 确保文件名有正确的后缀
          const targetExt = format ? getExtFromFormat(format) : guessImageExt(item.url || '', buffer)
          const currentExt = path.extname(safeName)
          if (!currentExt) {
            safeName += targetExt
          } else if (format && format !== 'original') {
            safeName = safeName.replace(new RegExp(`${currentExt}$`), targetExt)
          }

          downloaded[idx] = { ok: true, filenameInZip: safeName, buffer, size: buffer.length }
          console.log(`  [${idx + 1}/${items.length}] ✅ 下载完成，${(buffer.length / 1024).toFixed(1)} KB → zip内命名：${safeName}`)
        } catch (err) {
          console.error(`  [${idx + 1}/${items.length}] ❌ 下载失败:`, err.message)
          downloaded[idx] = { ok: false, error: err.message }
        }
      }
    }

    // 启动 3 个 worker
    const workers = []
    for (let w = 0; w < MAX_CONCURRENT; w++) workers.push(worker(w))
    await Promise.all(workers)

    const successList = downloaded.filter(d => d && d.ok)
    const failList = downloaded.filter(d => d && !d.ok)
    console.log(`[批量打包ZIP] 下载完毕：成功 ${successList.length} 张，失败 ${failList.length} 张`)

    if (successList.length === 0) {
      return res.status(500).json({ success: false, message: '所有图片下载均失败，请检查网络或图片URL有效性' })
    }

    // 2. JSZip 打包
    console.log(`[批量打包ZIP] 正在生成 zip 压缩包...`)
    const zip = new JSZip()
    // zip内部重名避免
    const zipUsedNames = new Map()
    successList.forEach(item => {
      let finalZipName = item.filenameInZip
      const ext = path.extname(finalZipName)
      const base = path.basename(finalZipName, ext)
      if (zipUsedNames.has(base)) {
        const c = zipUsedNames.get(base) + 1
        zipUsedNames.set(base, c)
        finalZipName = `${base}_${c}${ext}`
      } else {
        zipUsedNames.set(base, 1)
      }
      zip.file(finalZipName, item.buffer)
    })

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    console.log(`[批量打包ZIP] 压缩包大小: ${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB`)

    // 3. 写入到 download 目录
    const now = new Date()
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    let safeZipName = sanitizeFilename(zipFilename || `批量生图_${ts}.zip`)
    if (!safeZipName.toLowerCase().endsWith('.zip')) safeZipName += '.zip'
    const finalZipFileName = getSafeFileName(DOWNLOAD_DIR, safeZipName)
    const savePath = path.join(DOWNLOAD_DIR, finalZipFileName)
    fs.writeFileSync(savePath, zipBuffer)

    const sizeMB = (zipBuffer.length / 1024 / 1024).toFixed(2)
    console.log(`[压缩包已保存] ${finalZipFileName}  (${sizeMB} MB)  →  ${DOWNLOAD_DIR}`)
    res.json({
      success: true,
      message: `打包成功：成功 ${successList.length} 张，失败 ${failList.length} 张`,
      filename: finalZipFileName,
      savePath,
      sizeMB: Number(sizeMB),
      successCount: successList.length,
      failCount: failList.length,
      failedItems: failList.map((f, i) => ({ index: i, error: f.error }))
    })
  } catch (err) {
    console.error('[save-zip-from-urls失败]:', err)
    res.status(500).json({ success: false, message: `打包失败: ${err.message}` })
  }
})

// ========== 功能3（兼容模式）：前端上传ZIP，后端保存 ==========
app.post('/save-zip', upload.single('zipfile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '没有收到压缩包文件，建议改用 save-zip-from-urls JSON 模式' })
    }
    let safeName = sanitizeFilename(req.query.filename || req.body.filename || req.file.originalname)
    if (!safeName.toLowerCase().endsWith('.zip')) safeName += '.zip'
    const finalFileName = getSafeFileName(DOWNLOAD_DIR, safeName)
    const savePath = path.join(DOWNLOAD_DIR, finalFileName)
    fs.writeFileSync(savePath, req.file.buffer)
    const sizeMB = (req.file.size / 1024 / 1024).toFixed(2)
    console.log(`[压缩包已保存(上传模式)] ${finalFileName}  (${sizeMB} MB)`)
    res.json({ success: true, message: '保存成功', filename: finalFileName, savePath, sizeMB: Number(sizeMB) })
  } catch (err) {
    console.error('[save-zip上传模式失败]:', err)
    res.status(500).json({ success: false, message: `保存失败: ${err.message}` })
  }
})

// 简单的健康检查接口
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    msg: '后端服务运行中',
    downloadDir: DOWNLOAD_DIR
  })
})

app.listen(PORT, () => {
  console.log('========================================')
  console.log(`🚀 批量AI生图 - 本地后端服务已启动`)
  console.log(`📍 服务地址: http://localhost:${PORT}`)
  console.log(`💾 下载目录: ${DOWNLOAD_DIR}`)
  console.log(`🌐 API代理: /api/*  -> https://ark.cn-beijing.volces.com/api/*`)
  console.log(`📸 保存单图✅推荐: POST JSON {imageUrl,filename} -> /save-image`)
  console.log(`📦 批量打包✅推荐: POST JSON {items:[{url,filename}]} -> /save-zip-from-urls`)
  console.log(`💽 兼容文件上传 : /save-image (multipart) 和 /save-zip (multipart)`)
  console.log('========================================')
})
