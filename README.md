# Batch-Image-Generation 批量AI生图工具

一个基于 React + Vite + Express 的本地批量 AI 生图工具，调用火山方舟（Volcengine Ark）`doubao-seedream-5-0` 模型，支持按主题批量生成图片、单张重生成、批量打包下载到本地 `download` 文件夹。

## 功能特性

- **批量生图**：一次性输入多个主题（每行一个），自动并发调用 API 生成图片（并发上限 3，避免限流）。
- **风格模板**：内置 4 种风格（日系手绘、扁平化矢量、Q版卡通、写实摄影），每个风格带预设描述与主题色。
- **自定义提示词**：可在风格之外追加自定义正向提示词；负向提示词固定（畸形、文字、水印、模糊、杂乱背景）。
- **尺寸支持**：预设 1920×1920 / 2048×2048 / 2K / 3K / 4K，并支持自定义宽高。会校验是否满足 API 最小像素要求（3,686,400 像素，即 1920×1920）。
- **多格式输出**：PNG / JPG / WebP，通过后端 `sharp` 转换。
- **本地保存（推荐路径）**：
  - 单张：调用后端 `/save-image`，后端用 `axios` 直接下载图片 URL 并写入 `download/`，彻底无 CORS 问题。
  - 批量：调用后端 `/save-zip-from-urls`，后端并发下载并用 `JSZip` 打包成 zip 写入 `download/`。
- **前端兜底**：后端不可用时，前端会自动用 `<a download>` / `JSZip` + Blob 方式直接在浏览器下载，并 Toast 提示用户启动后端。
- **后端健康检测**：前端每 15 秒轮询 `/health`，未启动时顶部醒目红色提示，并给出启动命令。
- **状态持久化**：主题、风格、自定义提示词、尺寸、格式均保存到 `localStorage`，刷新不丢。
- **失败重试**：单张生图自动最多重试 2 次（间隔 1.5 秒），最终失败可在结果卡片上一键重试。
- **Toast 通知**：右下角弹出操作结果，4.5 秒自动消失。

## 技术栈

- 前端：React 18 + Vite 5
- 后端：Express 5 + Multer + Axios + JSZip + Sharp
- 模型：火山方舟 `doubao-seedream-5-0-260128`
- 部署形态：纯本地（前端 Vite dev server + 后端 Express 3001 端口）

## 目录结构

```
批量生图max版本/
├── server.cjs              # 后端服务（API 代理 + 图片保存 + ZIP 打包）
├── src/
│   ├── App.jsx             # 主组件（状态管理 + UI + 生图/下载逻辑）
│   ├── App.css             # 组件样式
│   ├── index.css           # 全局样式
│   └── main.jsx            # React 入口
├── index.html              # HTML 模板
├── vite.config.js          # Vite 配置
├── package.json
├── download/               # 后端生成的图片/zip 输出目录（自动创建）
└── dist/                   # 前端构建产物
```

## 安装与使用

### 1. 安装依赖

```bash
npm install
```

### 2. 启动后端服务（关键）

后端必须先启动，否则生图和下载到 `download` 文件夹的功能不可用。在项目根目录新开一个终端：

```bash
npm run server
```

后端默认监听 `http://localhost:3001`，启动后会打印路由列表。

### 3. 启动前端开发服务器

```bash
npm run dev
```

打开浏览器访问 Vite 提示的地址（默认 `http://localhost:5173`）。

### 4. 使用流程

1. 在「API Key」输入框填入火山方舟 API Key。
2. 在「批量主题」文本框每行输入一个主题。
3. 选择风格模板（可选）和自定义正向提示词（可选）。
4. 选择尺寸与输出格式。
5. 点击「批量生成」，等待并发完成。
6. 在结果区点单张「💾 保存到download文件夹」或顶部「📦 批量打包保存到download文件夹」。
7. 文件输出在项目根目录的 `download/` 文件夹。

### 5. 构建前端（可选）

```bash
npm run build
```

产物在 `dist/`，可直接部署到静态托管。

## 后端 API 说明

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回下载目录路径 |
| ANY | `/api/*` | 代理转发到 `https://ark.cn-beijing.volces.com/api/*`，解决 CORS |
| POST | `/save-image` | JSON 模式：`{imageUrl, filename, format}` → 后端下载并保存单图 |
| POST | `/save-image` | multipart 模式：上传图片文件，兼容旧路径 |
| POST | `/save-zip-from-urls` | JSON 模式：`{items:[{url,filename}], zipFilename, format}` → 后端批量下载并打包 |
| POST | `/save-zip` | multipart 模式：上传 zip 文件，兼容旧路径 |

文件名清理、重名处理（自动追加 `(2)` `(3)`）、格式转换（PNG/JPG/WebP）均由后端统一完成。

## 前端兜底策略

- **后端不可用**：前端自动改用浏览器 `<a download>` / `JSZip` + Blob 方式下载，并 Toast 提示用户启动后端以获得更好体验。
- **生图请求失败**：自动最多重试 2 次；仍失败则在结果卡片显示错误并支持一键「🔄 重试重新生成」。
- **超时**：`fetchWithTimeout` 单图 10 秒、保存 45 秒、批量打包按图片数动态计算。

## 常见问题

- **顶部红色提示「后端服务未启动」**：执行 `npm run server` 启动后端；启动后等 15 秒或点「刷新检测」。
- **生成失败提示「请求超时」**：检查后端是否运行、API Key 是否有效、网络是否可访问火山方舟。
- **尺寸校验不通过**：API 要求最小 3,686,400 像素（1920×1920），请改用 2K 及以上预设或更大的自定义尺寸。
- **下载的文件名异常**：文件名会自动清理 `\ / : * ? " < > |` 等非法字符，长度限制 120 字符。

## License

MIT
