/**
 * Ảnh bài làm sau khi quét: ảnh nắn thẳng + lớp đánh dấu đúng/sai (xanh/đỏ/cam).
 * Bấm vào ảnh -> trình xem lớn: phóng to / thu nhỏ, bật/tắt lớp đánh dấu, xem ảnh gốc.
 */
import { RefObject, useEffect, useRef, useState } from 'react'
import type { CellId, OverlayGeo, PaperAnswers, PaperConfig } from '../utils/omr'
import { drawGrades, loadImage } from '../utils/overlay'

interface Props {
  /** ảnh nắn thẳng chưa vẽ gì + toạ độ ô (phiếu tô ô) */
  base?: string
  geo?: OverlayGeo
  /** ảnh dùng khi không có lớp đánh dấu (phiếu viết tay / ảnh gốc) */
  fallback: string
  /** ảnh chụp gốc (nút "Ảnh gốc" trong trình xem) */
  original?: string
  answers?: PaperAnswers
  answerKey?: PaperAnswers
  flags?: Record<CellId, string>
  cfg: PaperConfig
  width?: number
  alt?: string
}

/** Vẽ ảnh (kèm/không kèm lớp đánh dấu) lên canvas */
function useDraw(
  canvas: RefObject<HTMLCanvasElement>,
  p: Props,
  show: boolean,
  active: boolean,
): boolean {
  const [ready, setReady] = useState(false)
  const { base, geo, answers, answerKey, flags, cfg } = p
  useEffect(() => {
    if (!active || !base || !geo) return
    let alive = true
    loadImage(base)
      .then((img) => {
        const c = canvas.current
        if (!alive || !c) return
        c.width = geo.w
        c.height = geo.h
        const ctx = c.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, geo.w, geo.h)
        if (show && answers) drawGrades(ctx, geo, answers, answerKey, flags || {}, cfg)
        setReady(true)
      })
      .catch(() => setReady(false))
    return () => {
      alive = false
    }
  }, [active, base, geo, answers, answerKey, flags, cfg, show, canvas])
  return ready
}

export function MarkLegend({ hasKey }: { hasKey: boolean }) {
  return (
    <div className="mark-legend">
      {hasKey ? (
        <>
          <span>
            <i className="dot ok" /> Câu đúng
          </span>
          <span>
            <i className="dot bad" /> Câu sai
          </span>
          <span>
            <i className="dot bad dashed" /> Đáp án đúng
          </span>
        </>
      ) : (
        <span>
          <i className="dot read" /> Ô máy đọc được
        </span>
      )}
      <span>
        <i className="dot warn" /> Cần rà
      </span>
    </div>
  )
}

export default function GradedImage(props: Props) {
  const { base, geo, fallback, original, answerKey, width = 360, alt = 'Ảnh phiếu' } = props
  const hasLayer = !!(base && geo && props.answers)
  const thumb = useRef<HTMLCanvasElement>(null)
  const [open, setOpen] = useState(false)
  const ready = useDraw(thumb, props, true, hasLayer)

  return (
    <div className="graded-img" style={{ width, maxWidth: '100%' }}>
      <button type="button" className="img-btn" onClick={() => setOpen(true)} title="Bấm để phóng to">
        {hasLayer ? (
          <canvas ref={thumb} style={{ width: '100%', display: ready ? 'block' : 'none' }} />
        ) : null}
        {(!hasLayer || !ready) && <img src={fallback} alt={alt} />}
        <span className="zoom-hint">🔍 Phóng to</span>
      </button>
      {hasLayer && <MarkLegend hasKey={!!answerKey} />}
      {open && <ImageViewer {...props} onClose={() => setOpen(false)} originalSrc={original || fallback} />}
    </div>
  )
}

/** Trình xem ảnh lớn: phóng to/thu nhỏ, bật/tắt lớp đánh dấu, đổi sang ảnh gốc */
function ImageViewer(props: Props & { onClose: () => void; originalSrc: string }) {
  const { base, geo, onClose, originalSrc, answerKey } = props
  const hasLayer = !!(base && geo && props.answers)
  const [mode, setMode] = useState<'marked' | 'plain' | 'original'>(hasLayer ? 'marked' : 'original')
  const [zoom, setZoom] = useState(1)
  const cv = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const ready = useDraw(cv, props, mode === 'marked', hasLayer && mode !== 'original')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(4, z * 1.25))
      if (e.key === '-') setZoom((z) => Math.max(0.5, z / 1.25))
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const zoomBy = (f: number) => setZoom((z) => Math.min(4, Math.max(0.5, Math.round(z * f * 100) / 100)))
  const imgStyle = { width: `${zoom * 100}%`, maxWidth: 'none', display: 'block', margin: '0 auto' }

  return (
    <div className="viewer" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <div className="seg small">
          {hasLayer && (
            <>
              <button type="button" className={mode === 'marked' ? 'on' : ''} onClick={() => setMode('marked')}>
                Có đánh dấu
              </button>
              <button type="button" className={mode === 'plain' ? 'on' : ''} onClick={() => setMode('plain')}>
                Tắt đánh dấu
              </button>
            </>
          )}
          <button type="button" className={mode === 'original' ? 'on' : ''} onClick={() => setMode('original')}>
            Ảnh gốc
          </button>
        </div>
        <div className="zoom-ctl">
          <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label="Thu nhỏ">
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => zoomBy(1.25)} aria-label="Phóng to">
            +
          </button>
          <button type="button" onClick={() => setZoom(1)}>
            Vừa khung
          </button>
        </div>
        <button type="button" className="viewer-close" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </div>
      <div className="viewer-body" ref={box} onClick={(e) => e.stopPropagation()}>
        {mode === 'original' || !hasLayer ? (
          <img src={originalSrc} alt="Ảnh phiếu gốc" style={imgStyle} />
        ) : (
          <>
            <canvas ref={cv} style={{ ...imgStyle, visibility: ready ? 'visible' : 'hidden' }} />
          </>
        )}
      </div>
      {hasLayer && mode === 'marked' && (
        <div className="viewer-legend" onClick={(e) => e.stopPropagation()}>
          <MarkLegend hasKey={!!answerKey} />
        </div>
      )}
    </div>
  )
}
