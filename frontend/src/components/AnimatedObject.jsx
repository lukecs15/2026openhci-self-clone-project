/**
 * AnimatedObject.jsx — 3D 物件動畫狀態元件
 *
 * 三種動畫狀態：
 *   idle     — 緩慢浮動（sin 波），代表物件在場景中靜候
 *   talking  — 輕微震動 + 呼吸縮放 + 發光 emissive，代表物件正在說話
 *   listening — 略微縮小 + 輕脈衝，代表物件正在聆聽使用者說話
 *
 * Props：
 *   @param {object}  object       - { object_id, model_url, object_name }
 *   @param {string}  status       - 'idle' | 'talking' | 'listening'
 *   @param {[x,y,z]} position     - 在場景中的座標
 *   @param {number}  baseY        - 浮動動畫的基準 Y 軸位置
 *
 * TODO: 當 model_url 為 GLB 時，換用 useGLTF 載入真實模型
 * TODO: 加入 talking 時的 LipSync 動畫（透過 morph target）
 * TODO: 發光顏色根據物件 personality 動態調整
 */

import { useRef, useState, useMemo, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { Html, useGLTF } from '@react-three/drei'
import SpeechBubble from './SpeechBubble'

/** 物件狀態對應的材質顏色 */
const STATUS_COLORS = {
  idle:      '#6366f1',   // 靜默：紫藍
  talking:   '#a78bfa',   // 說話：亮紫
  listening: '#4f46e5',   // 聆聽：深紫
}

/** 物件狀態對應的 emissive 強度 */
const STATUS_EMISSIVE = {
  idle:      0.05,
  talking:   0.35,
  listening: 0.02,
}

function FallbackMesh({ status }) {
  /**
   * 若無 GLB model_url，使用 icosahedron 作為 placeholder。
   * TODO: 換成更具辨識度的幾何體或 sprite
   */
  const color = STATUS_COLORS[status] || STATUS_COLORS.idle
  const emissive = STATUS_EMISSIVE[status] || 0.05
  return (
    <mesh>
      <icosahedronGeometry args={[0.6, 1]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={emissive}
        roughness={0.3}
        metalness={0.5}
      />
    </mesh>
  )
}

function GLBModel({ url, status }) {
  const { scene } = useGLTF(url)

  // 克隆避免多個實例共用同一個 Three.js scene graph
  const cloned = useMemo(() => scene.clone(true), [scene])

  // 套用狀態 emissive，解決模型全黑問題
  useEffect(() => {
    const emissiveColor = STATUS_COLORS[status] || STATUS_COLORS.idle
    const emissiveInt = STATUS_EMISSIVE[status] || 0.05
    cloned.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material]
        mats.forEach((mat) => {
          if (mat.emissive) mat.emissive.setStyle(emissiveColor)
          mat.emissiveIntensity = emissiveInt
          mat.needsUpdate = true
        })
      }
    })
  }, [cloned, status])

  // 自動縮放：計算 bounding box 並縮放到約 1.2 單位高
  useEffect(() => {
    const box = new THREE.Box3().setFromObject(cloned)
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    if (maxDim > 0) {
      const scale = 0.7 / maxDim
      cloned.scale.setScalar(scale)
    }
    // 置底（讓物件底部對齊 y=0）
    const box2 = new THREE.Box3().setFromObject(cloned)
    cloned.position.y -= box2.min.y
    // 旋轉 180°：Meshy.ai 的 GLB 預設面向 -Z，攝影機在 +Z 會看到背面
    cloned.rotation.y = Math.PI
  }, [cloned])

  return <primitive object={cloned} />
}

export default function AnimatedObject({
  object,
  status = 'idle',
  position = [0, 0, 0],
  baseY = 0,
  speechText = '',
}) {
  const groupRef = useRef()
  const [baseX] = useState(position[0])

  useFrame((state) => {
    if (!groupRef.current) return
    const t = state.clock.elapsedTime

    if (status === 'idle') {
      // 緩慢浮動（不同物件用不同相位，避免同步）
      const phase = object.object_id ? object.object_id.charCodeAt(0) * 0.5 : 0
      groupRef.current.position.y = baseY + Math.sin(t * 0.8 + phase) * 0.08
      groupRef.current.scale.setScalar(1)
    }

    else if (status === 'talking') {
      // 輕微震動
      groupRef.current.position.x = baseX + (Math.random() - 0.5) * 0.015
      groupRef.current.position.y = baseY + Math.sin(t * 1.5) * 0.04

      // 呼吸縮放
      const breathe = 1 + Math.sin(t * 6) * 0.03
      groupRef.current.scale.setScalar(breathe)
    }

    else if (status === 'listening') {
      // 縮小並輕脈衝
      groupRef.current.position.y = baseY
      groupRef.current.position.x = baseX
      const pulse = 0.92 + Math.sin(t * 2) * 0.02
      groupRef.current.scale.setScalar(pulse)
    }
  })

  const hasModel = object?.model_url && object.model_url.endsWith('.glb')

  return (
    <group ref={groupRef} position={position}>
      {/* 3D 模型或 placeholder */}
      {hasModel
        ? <GLBModel url={object.model_url} status={status} />
        : <FallbackMesh status={status} />
      }

      {/* 狀態光環（talking 時才顯示） */}
      {status === 'talking' && (
        <pointLight
          position={[0, 0.5, 0.5]}
          intensity={0.8}
          color="#a78bfa"
          distance={3}
        />
      )}

      {/* 物件名稱標籤（idle/listening 顯示） */}
      {status !== 'talking' && (
        <Html
          position={[0, -0.2, 0]}
          center
          distanceFactor={8}
          style={{ pointerEvents: 'none' }}
        >
          <div style={{
            color: 'rgba(203, 213, 225, 0.7)',
            fontSize: '12px',
            fontFamily: 'system-ui, sans-serif',
            textAlign: 'center',
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            whiteSpace: 'nowrap',
          }}>
            {object?.object_name || ''}
          </div>
        </Html>
      )}

      {/* 對話泡泡（talking 時顯示，放在模型正上方） */}
      {status === 'talking' && speechText && (
        <SpeechBubble
          text={speechText}
          objectName={object?.object_name || ''}
          yOffset={1.4}
        />
      )}
    </group>
  )
}
