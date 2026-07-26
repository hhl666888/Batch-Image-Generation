import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 配置Vite开发服务器代理，解决调用火山方舟API时的跨域CORS问题
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // 所有以 /api 开头的请求都会被代理到火山方舟服务器
      // 例如：/api/v3/images/generations -> https://ark.cn-beijing.volces.com/api/v3/images/generations
      '/api': {
        target: 'https://ark.cn-beijing.volces.com',
        changeOrigin: true,
        secure: true,
        // 路径保留原样（/api 已经是正确前缀）
        rewrite: (path) => path
      }
    }
  }
})
