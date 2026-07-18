import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 對照 voice_clone_frontend/vite.config.js 的 tunnel/代理設定。
//
// ── cloudflared 部署（單一 tunnel 打通前後端）──────────────────────────
// dev server 同時代理 REST 與 WebSocket 到後端：
//   /api → http://localhost:8200   /ws → ws://localhost:8200
// 前端程式碼預設走「同源相對路徑」（見 api/onboardingClient.js 與
// hooks/useDebateSession.js）：.env 的 VITE_API_BASE_URL / VITE_WS_BASE_URL
// 「留空」時，瀏覽器一律打回頁面自己的來源，由這裡的 proxy 轉發——
// 所以 cloudflared 只需要開一條 tunnel 指到這個 dev server（port 5174），
// 手機/展場機不管走 https tunnel 還是區網 IP 都不會有 CORS 或 mixed
// content 問題（wss 由同源自動推導）。後端不需要另外開 tunnel。
// 只有想讓前端「直連」另一台後端時才需要在 .env 填絕對網址。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:8200',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8200',
        ws: true,
      },
    },
    // Cloudflare quick tunnel 每次重啟換隨機子網域，用萬用字元放行
    // （理由見 voice_clone_frontend/vite.config.js 的說明）。
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
