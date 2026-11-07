import { useEffect, useRef, useState } from 'react'
import { canvasToJpeg } from '../utils/omr'

interface Props {
  onCapture: (dataUrl: string) => void
  onClose: () => void
  /** true: chụp xong vẫn để camera mở để chụp phiếu tiếp theo */
  continuous?: boolean
}

/**
 * Bật camera trực tiếp trên trình duyệt (điện thoại dùng camera sau).
 * Cần chạy trên HTTPS (Vercel đã có sẵn) và cho phép quyền camera.
 */
export default function CameraCapture({ onCapture, onClose, continuous = true }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [error, setError] = useState('')
  const [count, setCount] = useState(0)
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Trình duyệt không hỗ trợ bật camera. Hãy dùng nút "Chọn ảnh / file scan".')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => undefined)
        }
      } catch (e) {
        const name = (e as Error).name
        setError(
          name === 'NotAllowedError'
            ? 'Chưa cho phép dùng camera. Bấm biểu tượng ổ khoá cạnh địa chỉ web → cho phép Camera, rồi mở lại.'
            : name === 'NotFoundError'
              ? 'Không tìm thấy camera trên thiết bị này.'
              : `Không bật được camera: ${(e as Error).message}`,
        )
      }
    }
    start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  function capture() {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    const url = canvasToJpeg(v, v.videoWidth, v.videoHeight, 2000, 0.88)
    onCapture(url)
    setCount((c) => c + 1)
    setFlash(true)
    setTimeout(() => setFlash(false), 150)
    if (!continuous) onClose()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.92)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
      }}
    >
      {error ? (
        <div className="card" style={{ maxWidth: 420 }}>
          <p style={{ color: 'var(--danger)' }}>{error}</p>
          <button className="btn secondary" onClick={onClose}>
            Đóng
          </button>
        </div>
      ) : (
        <>
          <div style={{ position: 'relative', maxWidth: '100%', maxHeight: '78vh' }}>
            <video
              ref={videoRef}
              playsInline
              muted
              style={{ maxWidth: '100%', maxHeight: '78vh', display: 'block', borderRadius: 8, opacity: flash ? 0.3 : 1 }}
            />
            {/* Khung căn phiếu */}
            <div
              style={{
                position: 'absolute',
                inset: '6%',
                border: '2px dashed rgba(255,255,255,0.75)',
                borderRadius: 8,
                pointerEvents: 'none',
              }}
            />
          </div>
          <p style={{ color: 'white', fontSize: 13, margin: '8px 0', textAlign: 'center' }}>
            Đặt phiếu phẳng, đủ sáng, cả 3 bảng nằm trong khung nét đứt. Đã chụp: <b>{count}</b> phiếu
          </p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button className="btn accent" style={{ fontSize: 17, padding: '12px 28px' }} onClick={capture}>
              📸 Chụp
            </button>
            <button className="btn secondary" onClick={onClose}>
              Xong
            </button>
          </div>
        </>
      )}
    </div>
  )
}
