import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 開發時將 /api 請求代理到後端，避免 CORS 問題
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // 代理靜態 GLB 檔案（本地 3D 生成的輸出）
      '/static': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
