/**
 * VoiceScene.jsx — 多物件語音對話虛擬場景主元件
 *
 * 說話泡泡同步策略：
 *   1. 先 decodeAudioData（非同步，~50ms）
 *   2. decode 完成後才 setObjectStates → 泡泡出現
 *   3. source.start(0) → 音訊開始播放（與泡泡出現幾乎同步）
 *   4. source.onended 觸發泡泡消失；同時設置 duration*1000+500ms 精準 fallback
 *      防止某些瀏覽器 onended 不可靠
 *
 * 相機追焦：
 *   CameraLookAt（Canvas 子元件）用 useFrame + lerp 平滑追焦正在說話的物件，
 *   說話結束後回到場景中心。
 *
 * 物件排列：
 *   扇形弧線，R=5.5（從 6.0 收緊），halfAngle 更保守 → 物件更聚集。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Stars, Environment } from '@react-three/drei'
import AnimatedObject from './AnimatedObject'
import VoiceControls from './VoiceControls'
import { useVoiceConversation } from '../hooks/useVoiceConversation'
import useAppStore from '../store/useAppStore'

// ─────────────────────────────────────────────────────────────────────────────
// 場景環境元件
// ─────────────────────────────────────────────────────────────────────────────

function SpatialEnvironment() {
  return (
    <>
      <fog attach="fog" args={['#0d0d1f', 12, 30]} />

      {/* 地板 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.3, 0]} receiveShadow>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#090916" roughness={0.95} />
      </mesh>

      {/* 後牆 */}
      <mesh position={[0, 2.5, -6]} receiveShadow>
        <planeGeometry args={[18, 9]} />
        <meshStandardMaterial color="#0e0e20" roughness={0.98} />
      </mesh>

      {/* 左牆 */}
      <mesh rotation={[0, Math.PI / 2, 0]} position={[-8, 2.5, -1]} receiveShadow>
        <planeGeometry args={[10, 9]} />
        <meshStandardMaterial color="#0c0c1c" roughness={0.98} />
      </mesh>

      {/* 右牆 */}
      <mesh rotation={[0, -Math.PI / 2, 0]} position={[8, 2.5, -1]} receiveShadow>
        <planeGeometry args={[10, 9]} />
        <meshStandardMaterial color="#0c0c1c" roughness={0.98} />
      </mesh>

      {/* 桌面 */}
      <mesh position={[0, -0.04, -1.5]} receiveShadow castShadow>
        <boxGeometry args={[7.0, 0.1, 3.5]} />
        <meshStandardMaterial color="#2a1c0e" roughness={0.55} metalness={0.06} />
      </mesh>

      {/* 桌腳 */}
      {[[-3.2, -0.4], [3.2, -0.4], [-3.2, -2.6], [3.2, -2.6]].map(([x, z], i) => (
        <mesh key={i} position={[x, -0.69, z]} castShadow>
          <boxGeometry args={[0.12, 1.3, 0.12]} />
          <meshStandardMaterial color="#1a1208" roughness={0.8} />
        </mesh>
      ))}

      {/* 燈光 */}
      <ambientLight intensity={0.5} />
      <pointLight position={[0, 3.5, -1.5]} intensity={4.0} color="#ffe5b4" distance={9} castShadow />
      <pointLight position={[0, 2.0, 3.5]} intensity={1.5} color="#c8d8ff" distance={7} />
      <pointLight position={[-5, 2.0, -1]} intensity={0.5} color="#a78bfa" distance={6} />
      <pointLight position={[5, 2.0, -1]} intensity={0.4} color="#fbbf24" distance={6} />

      <Environment preset="apartment" />
    </>
  )
}

function AbstractEnvironment() {
  return (
    <>
      <color attach="background" args={['#07071a']} />
      <ambientLight intensity={0.9} />
      <pointLight position={[0, 4, 4]} intensity={2.2} color="#a78bfa" />
      <pointLight position={[3, -1, 2]} intensity={0.8} color="#6366f1" />
      <pointLight position={[-3, 2, 2]} intensity={0.7} color="#ffffff" />
      <Stars radius={50} depth={30} count={800} factor={3} fade saturation={0.5} />
      <Environment preset="night" />
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 扇形排列（收緊版：R=5.5，halfAngle 更小）
// ─────────────────────────────────────────────────────────────────────────────

function computeArcPositions(count) {
  if (count === 1) return [[0, 0, -1.0]]

  const positions = []
  const camZ = 4.5
  const R = 5.5                                           // 原 6.0 → 收緊
  const halfAngle = Math.min(Math.PI * 0.20, count * 0.09) // 原 0.28/0.13 → 更保守
  const startAngle = -halfAngle
  const step = (halfAngle * 2) / (count - 1)

  for (let i = 0; i < count; i++) {
    const angle = startAngle + step * i
    const x = R * Math.sin(angle)
    const z = camZ - R * Math.cos(angle)
    const cx = Math.max(-2.5, Math.min(2.5, x))          // 邊界也收緊（原 3.0）
    positions.push([cx, 0, z])
  }
  return positions
}

// ─────────────────────────────────────────────────────────────────────────────
// 相機平滑追焦（需在 Canvas 內部以使用 useFrame）
// ─────────────────────────────────────────────────────────────────────────────

function CameraLookAt({ controlsRef, goal }) {
  const goalVec = useRef(new THREE.Vector3(goal[0], goal[1], goal[2]))

  useEffect(() => {
    goalVec.current.set(goal[0], goal[1], goal[2])
  }, [goal])

  useFrame(() => {
    if (!controlsRef.current) return
    const t = controlsRef.current.target
    // lerp 速度 0.08：約 0.6 秒達到 95% 目標（60fps）
    t.x += (goalVec.current.x - t.x) * 0.08
    t.y += (goalVec.current.y - t.y) * 0.08
    t.z += (goalVec.current.z - t.z) * 0.08
    controlsRef.current.update()
  })

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 主元件
// ─────────────────────────────────────────────────────────────────────────────

export default function VoiceScene({ objects = [], sessionId, initialSceneMode = 'spatial' }) {
  const [sceneMode, setSceneMode] = useState(initialSceneMode)
  const [objectStates, setObjectStates] = useState(
    () => Object.fromEntries(objects.map(o => [o.object_id, { status: 'idle', speechText: '' }]))
  )
  const [userTranscript, setUserTranscript] = useState('')
  const [canEnd, setCanEnd] = useState(false)
  const [phase, setPhase] = useState('intro')
  const [introQueue, setIntroQueue] = useState([])
  const [sessionReady, setSessionReady] = useState(false)

  // 相機追焦目標（[x, y, z]）
  const [cameraGoal, setCameraGoal] = useState([0, 0.4, -1.5])

  // ── 防止 intro 重複觸發 ────────────────────────────────────────────────────
  const introStartedRef = useRef(false)

  // ── 說話隊列 ─────────────────────────────────────────────────────────────
  const speakingQueueRef = useRef([])
  const isSpeakingRef   = useRef(false)
  const audioCtxRef     = useRef(null)   // 重用 AudioContext
  const currentSourceRef = useRef(null)  // 當前 AudioBufferSourceNode，用於中斷

  // 穩定的 objects / positions ref（讓 useCallback 閉包安全存取）
  const positions = computeArcPositions(objects.length)
  const objectsRef   = useRef(objects)
  const positionsRef = useRef(positions)
  useEffect(() => { objectsRef.current = objects }, [objects])
  useEffect(() => { positionsRef.current = positions })

  // OrbitControls ref（CameraLookAt 用）
  const controlsRef = useRef()

  const setVoiceSession = useAppStore(s => s.setVoiceSession)

  // ── 全部物件狀態批次更新 ──────────────────────────────────────────────────
  const setAllStatus = useCallback((status) => {
    setObjectStates(prev => {
      const next = {}
      for (const id in prev) {
        next[id] = { ...prev[id], status, speechText: status === 'idle' ? '' : prev[id].speechText }
      }
      return next
    })
  }, [])

  // ── 瀏覽器 TTS（帶精準 onend 回調）─────────────────────────────────────
  const speakWithTTS = useCallback((text, onDone) => {
    if (!window.speechSynthesis) { onDone(); return }
    window.speechSynthesis.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-TW'
    utterance.rate = 0.88

    const voices = window.speechSynthesis.getVoices()
    const zh = voices.find(v => v.lang.startsWith('zh'))
    if (zh) utterance.voice = zh

    let triggered = false
    const done = () => { if (!triggered) { triggered = true; onDone() } }

    utterance.onend = done
    utterance.onerror = done
    setTimeout(done, Math.max(6000, text.length * 280 + 2000))
    window.speechSynthesis.speak(utterance)
  }, [])

  // ── drainSpeakingQueue ───────────────────────────────────────────────────
  //
  // 同步流程（有音訊時）：
  //   1. shift queue
  //   2. decodeAudioData（~50ms，此時泡泡尚未顯示）
  //   3. setObjectStates → 泡泡出現（與音訊開始近乎同步）
  //   4. source.start(0) → 音訊播放
  //   5. source.onended OR setTimeout(duration+500ms) → 泡泡消失 → 下一個
  //
  const drainSpeakingQueue = useCallback(async () => {
    if (speakingQueueRef.current.length === 0) {
      isSpeakingRef.current = false
      setAllStatus('idle')
      setCameraGoal([0, 0.4, -1.5])
      return
    }

    isSpeakingRef.current = true
    const { objectId, text, audioB64 } = speakingQueueRef.current.shift()

    // 相機追焦：找出此物件的位置
    const objIdx = objectsRef.current.findIndex(o => o.object_id === objectId)
    if (objIdx >= 0) {
      const [px, py, pz] = positionsRef.current[objIdx] || [0, 0, -1]
      setCameraGoal([px, py + 0.5, pz])
    }

    // 泡泡消失 + 準備下一個說話者
    const onFinish = () => {
      currentSourceRef.current = null
      setObjectStates(prev => ({
        ...prev,
        [objectId]: { status: 'idle', speechText: '' },
      }))
      setTimeout(() => drainSpeakingQueue(), 400)
    }

    if (audioB64) {
      try {
        // Step 1：取得或建立 AudioContext
        if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
          audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
        }
        const ctx = audioCtxRef.current
        if (ctx.state === 'suspended') await ctx.resume()

        // Step 2：decode（此時泡泡尚未顯示，避免提早出現）
        const binary = atob(audioB64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const audioBuffer = await ctx.decodeAudioData(bytes.buffer)

        // Step 3：decode 完成，顯示泡泡（與即將開始的音訊同步）
        setObjectStates(prev => {
          const next = {}
          for (const id in prev) {
            next[id] = id === objectId
              ? { status: 'talking', speechText: text }
              : { ...prev[id], status: 'listening', speechText: '' }
          }
          return next
        })

        // Step 4：建立 source、設定精準雙重觸發
        const source = ctx.createBufferSource()
        source.buffer = audioBuffer
        source.connect(ctx.destination)
        currentSourceRef.current = source

        let finished = false
        const done = () => {
          if (finished) return
          finished = true
          onFinish()
        }

        // onended：音訊精準結束時觸發
        source.onended = done
        // fallback：audio duration（秒）轉毫秒 + 500ms 緩衝
        const fallbackMs = Math.ceil(audioBuffer.duration * 1000) + 500
        setTimeout(done, fallbackMs)

        // Step 5：播放（音訊與泡泡幾乎同步出現）
        source.start(0)

      } catch (err) {
        console.error('[VoiceScene] 音訊播放失敗，改用估算:', err)
        // 失敗仍要顯示泡泡
        setObjectStates(prev => {
          const next = {}
          for (const id in prev) {
            next[id] = id === objectId
              ? { status: 'talking', speechText: text }
              : { ...prev[id], status: 'listening', speechText: '' }
          }
          return next
        })
        setTimeout(onFinish, Math.max(3000, text.length * 100))
      }
    } else {
      // 無音訊：顯示泡泡後用瀏覽器 TTS
      setObjectStates(prev => {
        const next = {}
        for (const id in prev) {
          next[id] = id === objectId
            ? { status: 'talking', speechText: text }
            : { ...prev[id], status: 'listening', speechText: '' }
        }
        return next
      })
      speakWithTTS(text, onFinish)
    }
  }, [setAllStatus, speakWithTTS])

  // ── WebSocket callbacks ───────────────────────────────────────────────────
  const callbacks = {
    onSessionReady: useCallback((summary) => {
      setSessionReady(true)
      setPhase(summary.phase || 'intro')
      const queue = summary.objects?.map(o => o.object_id) || []
      setIntroQueue(queue)
    }, []),

    onObjectSpeaking: useCallback((objectId, objectName, text, audioB64) => {
      // 若 AudioContext 被暫停（onAllListening），先喚醒
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {})
      }
      speakingQueueRef.current.push({ objectId, objectName, text, audioB64 })
      if (!isSpeakingRef.current) {
        drainSpeakingQueue()
      }
    }, [drainSpeakingQueue]),

    onAllListening: useCallback(() => {
      speakingQueueRef.current = []
      isSpeakingRef.current = false

      // 立即停止當前播放中的音訊
      if (currentSourceRef.current) {
        try { currentSourceRef.current.stop() } catch (_) {}
        currentSourceRef.current = null
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.suspend().catch(() => {})
      }
      if (window.speechSynthesis) window.speechSynthesis.cancel()

      setCameraGoal([0, 0.4, -1.5])
      setAllStatus('listening')
      setUserTranscript('')
    }, [setAllStatus]),

    onUserTranscript: useCallback((text) => setUserTranscript(text), []),
    onCanEnd: useCallback(() => setCanEnd(true), []),

    onPhaseChanged: useCallback((newPhase) => {
      setPhase(newPhase)
      setAllStatus('idle')
    }, [setAllStatus]),

    onSceneModeChanged: useCallback((mode) => setSceneMode(mode), []),
    onError: useCallback((msg) => console.error('[VoiceScene] 錯誤:', msg), []),
  }

  const {
    connect, disconnect,
    isConnected, isRecording, recordingMode, setRecordingMode,
    startRecording, stopRecording,
    sendText, initSession, requestIntro, setSceneMode: wsSetSceneMode, endSession,
  } = useVoiceConversation(sessionId, callbacks)

  // ── 連接並初始化 ─────────────────────────────────────────────────────────
  useEffect(() => {
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  useEffect(() => {
    if (!isConnected || sessionReady) return
    const timeout = setTimeout(() => {
      initSession(
        objects.map(o => ({
          object_id: o.object_id,
          object_name: o.object_name,
          object_description: o.object_description || '',
          model_url: o.model_url || '',
          personality: o.personality || null,
        })),
        sceneMode
      )
    }, 300)
    return () => clearTimeout(timeout)
  }, [isConnected, sessionReady, objects, sceneMode, initSession])

  // ── 自我介紹序列 ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionReady || phase !== 'intro' || introQueue.length === 0) return
    if (introStartedRef.current) return
    introStartedRef.current = true
    introQueue.forEach((objectId, i) => {
      setTimeout(() => requestIntro(objectId), i * 300)
    })
  }, [sessionReady, phase, introQueue, requestIntro])

  // ── 場景切換 ─────────────────────────────────────────────────────────────
  const handleSceneToggle = useCallback(() => {
    const next = sceneMode === 'spatial' ? 'abstract' : 'spatial'
    setSceneMode(next)
    wsSetSceneMode(next)
  }, [sceneMode, wsSetSceneMode])

  // ── 結束對話 ─────────────────────────────────────────────────────────────
  const handleEnd = useCallback(() => {
    speakingQueueRef.current = []
    isSpeakingRef.current = false
    if (currentSourceRef.current) {
      try { currentSourceRef.current.stop() } catch (_) {}
      currentSourceRef.current = null
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel()
    endSession()
    setAllStatus('idle')
    setCameraGoal([0, 0.4, -1.5])
  }, [endSession, setAllStatus])

  // ── 物件位置 ─────────────────────────────────────────────────────────────
  const isSomeoneTalking = Object.values(objectStates).some(s => s.status === 'talking')

  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden' }}>
      <Canvas
        camera={{ position: [0, 2.0, 4.5], fov: 55 }}
        shadows
        style={{ background: sceneMode === 'spatial' ? '#0d0d1f' : '#07071a' }}
      >
        {sceneMode === 'spatial' ? <SpatialEnvironment /> : <AbstractEnvironment />}

        {objects.map((obj, i) => {
          const state = objectStates[obj.object_id] || { status: 'idle', speechText: '' }
          return (
            <AnimatedObject
              key={obj.object_id}
              object={obj}
              status={state.status}
              speechText={state.speechText}
              position={positions[i]}
              baseY={positions[i][1]}
            />
          )
        })}

        {/* 相機平滑追焦 */}
        <CameraLookAt controlsRef={controlsRef} goal={cameraGoal} />

        <OrbitControls
          ref={controlsRef}
          target={[0, 0.4, -1.5]}
          minPolarAngle={Math.PI / 6}
          maxPolarAngle={Math.PI * 0.58}
          minDistance={2.5}
          maxDistance={8}
          enablePan={false}
        />
      </Canvas>

      {/* 場景切換按鈕 */}
      <button
        onClick={handleSceneToggle}
        title={sceneMode === 'spatial' ? '切換：抽象模式' : '切換：空間模式'}
        style={{
          position: 'fixed', top: '5rem', right: '1.5rem',
          background: 'rgba(15, 23, 42, 0.7)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(99, 102, 241, 0.3)',
          borderRadius: '8px', padding: '0.5rem 0.75rem',
          color: '#94a3b8', cursor: 'pointer', fontSize: '0.8rem',
          zIndex: 50, transition: 'all 0.2s',
        }}
      >
        {sceneMode === 'spatial' ? '✦ 抽象' : '⬜ 空間'}
      </button>

      {/* 連接狀態 */}
      <div style={{
        position: 'fixed', top: '5rem', left: '1.5rem',
        display: 'flex', alignItems: 'center', gap: '0.4rem',
        color: '#64748b', fontSize: '0.75rem', zIndex: 50,
      }}>
        <div style={{
          width: '6px', height: '6px', borderRadius: '50%',
          background: isConnected ? '#22c55e' : '#ef4444',
        }} />
        {isConnected ? (phase === 'intro' ? '自我介紹中' : '對話中') : '連接中…'}
      </div>

      {/* 語音控制列 */}
      <VoiceControls
        isConnected={isConnected && phase === 'dialogue'}
        isRecording={isRecording}
        recordingMode={recordingMode}
        canEnd={canEnd}
        disabled={isSomeoneTalking}
        onStartRecord={startRecording}
        onStopRecord={stopRecording}
        onSendText={sendText}
        onEndSession={handleEnd}
        onToggleMode={() => setRecordingMode(m => m === 'push' ? 'toggle' : 'push')}
        userTranscript={userTranscript}
      />
    </div>
  )
}
