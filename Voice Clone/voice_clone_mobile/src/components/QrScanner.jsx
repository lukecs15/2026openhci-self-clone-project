/**
 * QrScanner.jsx — 用手機相機即時掃描 QR code（連結上傳步驟用）
 *
 * 需求：手機端先獨立填完問卷、錄好聲音樣本後，才用相機掃主系統畫面上的
 * QR code 取得 session id（見 pages/OnboardingFlow.jsx 的 'connect' 步驟）
 * ——不是一進頁面就要求輸入 session id。
 *
 * 用 getUserMedia 取得後鏡頭畫面（facingMode: 'environment'）、畫進隱藏的
 * <canvas>、每一幀用 jsQR 解碼，解碼成功就呼叫 onDecode(text) 並停止繼續
 * 掃描（呼叫端收到結果後通常會切換畫面，不需要這個元件自己管理「掃到後
 * 還要不要繼續掃」的狀態）。
 *
 * getUserMedia 需要安全情境（HTTPS 或 localhost）才能用，行動裝置在區網
 * IP + 純 HTTP 下通常會被瀏覽器擋掉——這是瀏覽器本身的限制，不是這支程式
 * 的 bug，UI 上用 onError 顯示清楚的錯誤訊息，並讓呼叫端提供手動輸入的
 * 退路（見 OnboardingFlow.jsx 的 ConnectStep）。
 */

import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { colors } from '../styles/theme'

export default function QrScanner({ onDecode }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const rafIdRef = useRef(null)
  const streamRef = useRef(null)
  const onDecodeRef = useRef(onDecode)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  // 用 ref 保存最新的 onDecode，避免它是呼叫端每次 render 都重新產生的
  // inline function 時，讓下面的相機初始化 effect 反覆重跑（重跑代表重新
  // 要求相機權限、畫面閃爍）。
  useEffect(() => {
    onDecodeRef.current = onDecode
  }, [onDecode])

  useEffect(() => {
    let cancelled = false

    const tick = () => {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d')
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        })
        if (code && code.data) {
          onDecodeRef.current(code.data)
          return // 解碼成功，不再繼續排下一幀
        }
      }
      rafIdRef.current = requestAnimationFrame(tick)
    }

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        if (!cancelled) {
          setReady(true)
          rafIdRef.current = requestAnimationFrame(tick)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err && err.message ? err.message : '無法開啟相機')
        }
      }
    }

    start()

    return () => {
      cancelled = true
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div
        style={{
          position: 'relative',
          borderRadius: '0.75rem',
          overflow: 'hidden',
          background: '#000',
          aspectRatio: '1 / 1',
        }}
      >
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        <canvas ref={canvasRef} style={{ display: 'none' }} />
      </div>

      {error ? (
        <p style={{ margin: 0, fontSize: '0.8rem', color: colors.danger }}>
          無法開啟相機（{error}），請改用下方手動輸入 session id。
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: '0.75rem', color: colors.textFaint, textAlign: 'center' }}>
          {ready ? '請對準主系統畫面上的 QR code' : '正在啟動相機…'}
        </p>
      )}
    </div>
  )
}
