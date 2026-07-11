import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 跟 voice_clone_frontend（5174）、後端（8200）錯開。手機測試時通常會
    // 用區網 IP 開這個 port（例如 http://192.168.x.x:5175），host: true
    // 讓 vite dev server 監聽所有介面，不是只有 localhost。
    port: 5175,
    host: true,
    // Vite 5+ 預設只接受 Host header 是 localhost / 區網 IP 的請求（防
    // DNS rebinding），用 cloudflared / ngrok 之類的通道打出去時，瀏覽器帶
    // 的 Host 會是 xxx.trycloudflare.com，不在白名單內會直接被擋
    // 「Blocked request. This host is not allowed.」。這裡開發環境直接全部
    // 允許；正式對外服務不會用這個 dev server，不用擔心。
    allowedHosts: true,
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
