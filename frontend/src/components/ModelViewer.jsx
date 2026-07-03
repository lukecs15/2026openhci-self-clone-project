/**
 * ModelViewer.jsx - Three.js 3D 模型展示組件
 *
 * 功能：
 * - 使用 @react-three/fiber 與 @react-three/drei 載入 GLB 模型
 * - OrbitControls（滑鼠旋轉、縮放、平移）
 * - Wireframe toggle
 * - 環境光源與方向光
 * - 載入中動畫（旋轉佔位圖形）
 * - 錯誤邊界處理
 */

import { Suspense, useRef, useState, Component } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, useGLTF, Environment, Center } from '@react-three/drei'
import * as THREE from 'three'

// ── Error Boundary（捕捉 Three.js / GLB 載入錯誤） ──
class ModelErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }
  render() {
    if (this.state.hasError) {
      return (
        <mesh>
          <boxGeometry args={[1.5, 1.5, 1.5]} />
          <meshStandardMaterial color="#ef4444" wireframe />
        </mesh>
      )
    }
    return this.props.children
  }
}

// ── 載入動畫佔位組件 ─────────────────────────────
function LoadingSpinner() {
  const meshRef = useRef()
  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 1.5
      meshRef.current.rotation.x += delta * 0.5
    }
  })
  return (
    <mesh ref={meshRef}>
      <torusKnotGeometry args={[0.8, 0.25, 100, 16]} />
      <meshStandardMaterial color="#6366f1" wireframe />
    </mesh>
  )
}

// ── GLB 模型組件 ──────────────────────────────────
function GLBModel({ url, wireframe, colorTint }) {
  const { scene } = useGLTF(url)
  const cloned = scene.clone(true)

  // 套用 wireframe 與顏色 tint
  cloned.traverse((child) => {
    if (child.isMesh) {
      child.material = child.material.clone()
      child.material.wireframe = wireframe
      if (colorTint !== '#ffffff') {
        child.material.color.multiply(new THREE.Color(colorTint))
      }
    }
  })

  return (
    <Center>
      <primitive object={cloned} />
    </Center>
  )
}

// ── 主要展示組件 ──────────────────────────────────
/**
 * 3D 模型展示器。
 *
 * @param {object} props
 * @param {string|null} props.modelUrl - GLB 模型 URL（為 null 時顯示佔位動畫）
 * @param {string} [props.status='idle'] - 任務狀態
 * @param {number} [props.progress=0] - 進度 0–100
 */
export default function ModelViewer({ modelUrl, status = 'idle', progress = 0 }) {
  const [wireframe, setWireframe] = useState(false)
  const [colorTint, setColorTint] = useState('#ffffff')

  const isLoading = status === 'pending' || status === 'in_progress'
  const hasModel = status === 'succeeded' && modelUrl

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* 狀態提示列 */}
      {isLoading && (
        <div style={{
          background: '#1e293b',
          borderRadius: '8px',
          padding: '0.75rem 1rem',
          color: '#94a3b8',
          fontSize: '0.875rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
        }}>
          <div style={{
            width: '100%',
            background: '#334155',
            borderRadius: '9999px',
            height: '6px',
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${progress}%`,
              background: '#6366f1',
              height: '100%',
              borderRadius: '9999px',
              transition: 'width 0.5s ease',
            }} />
          </div>
          <span style={{ whiteSpace: 'nowrap' }}>{progress}%</span>
        </div>
      )}

      {/* 3D 畫布 */}
      <div style={{
        width: '100%',
        height: '480px',
        borderRadius: '12px',
        overflow: 'hidden',
        border: '2px solid #1e293b',
        background: '#0a0f1e',
      }}>
        <Canvas
          camera={{ position: [0, 1.5, 4], fov: 50 }}
          gl={{ antialias: true, alpha: false }}
          onCreated={({ gl, scene }) => {
            // 強制深色背景，避免 Environment preset 把場景染藍
            gl.setClearColor('#0a0f1e', 1)
            scene.background = new THREE.Color('#0a0f1e')
          }}
        >
          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 8, 5]} intensity={1.2} castShadow />
          <directionalLight position={[-5, -2, -5]} intensity={0.3} />
          {/* background={false} 避免 city HDRI 把場景背景變藍天 */}
          <Environment preset="city" background={false} />

          <Suspense fallback={<LoadingSpinner />}>
            <ModelErrorBoundary>
              {hasModel
                ? <GLBModel url={modelUrl} wireframe={wireframe} colorTint={colorTint} />
                : <LoadingSpinner />
              }
            </ModelErrorBoundary>
          </Suspense>

          <OrbitControls
            enableDamping
            dampingFactor={0.05}
            minDistance={1}
            maxDistance={20}
          />
        </Canvas>
      </div>

      {/* 控制列（僅在有模型時顯示） */}
      {hasModel && (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={() => setWireframe((w) => !w)}
            style={{
              padding: '0.4rem 0.9rem',
              borderRadius: '6px',
              border: `1px solid ${wireframe ? '#6366f1' : '#334155'}`,
              background: wireframe ? '#312e81' : '#1e293b',
              color: wireframe ? '#a5b4fc' : '#94a3b8',
              cursor: 'pointer',
              fontSize: '0.8rem',
            }}
          >
            {wireframe ? '◉ 線框模式' : '○ 線框模式'}
          </button>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#94a3b8', fontSize: '0.8rem' }}>
            色彩疊加
            <input
              type="color"
              value={colorTint}
              onChange={(e) => setColorTint(e.target.value)}
              style={{ width: '2rem', height: '2rem', border: 'none', cursor: 'pointer', borderRadius: '4px' }}
            />
          </label>

          <button
            onClick={() => setColorTint('#ffffff')}
            style={{
              padding: '0.4rem 0.9rem',
              borderRadius: '6px',
              border: '1px solid #334155',
              background: '#1e293b',
              color: '#94a3b8',
              cursor: 'pointer',
              fontSize: '0.8rem',
            }}
          >
            重設顏色
          </button>

          <a
            href={modelUrl}
            download="model.glb"
            style={{
              padding: '0.4rem 0.9rem',
              borderRadius: '6px',
              background: '#1e293b',
              color: '#94a3b8',
              textDecoration: 'none',
              fontSize: '0.8rem',
              border: '1px solid #334155',
            }}
          >
            ↓ 下載 GLB
          </a>
        </div>
      )}

      {status === 'failed' && (
        <div style={{ color: '#f87171', fontSize: '0.875rem', padding: '0.75rem', background: '#450a0a', borderRadius: '8px' }}>
          ⚠ 3D 生成失敗，請重試或換一張圖片。
        </div>
      )}
    </div>
  )
}
