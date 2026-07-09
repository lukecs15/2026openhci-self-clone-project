import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      // 開發時代理 WebSocket 到後端（避免 CORS/跨源問題）
      '/ws': {
        target: 'ws://localhost:8200',
        ws: true,
      },
    },
    // 修過的真實問題：這裡原本寫死某一次 cloudflared quick tunnel 產生的
    // 隨機網址（例如 holidays-kick-execute-halloween.trycloudflare.com）。
    // Cloudflare quick tunnel 每次重啟都會換一個全新的隨機子網域，寫死單一
    // 網址等於每次重開 tunnel 就要記得回來改這裡，忘記改就會被 Vite dev
    // server 直接拒絕（Blocked request）。改用開頭帶點的萬用字元寫法，
    // 讓任何 *.trycloudflare.com 子網域都能通過，不用每次手動更新。
    allowedHosts: ['.trycloudflare.com'],
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
