/**
 * Tóm tắt kết quả một bài: danh sách CÂU ĐÚNG / CÂU SAI / BỎ TRỐNG tách theo Phần I, II, III,
 * kèm tổng số và bộ lọc để giáo viên nắm nhanh.
 */
import { useState } from 'react'
import { PaperAnswers, PaperConfig, TF_KEYS, paperShortEqual, scorePaper, skipsP3, tfLabel } from '../utils/omr'

type Filter = 'all' | 'right' | 'wrong'

interface Props {
  cfg: PaperConfig
  answers: PaperAnswers
  answerKey: PaperAnswers
  compact?: boolean
}

interface Item {
  label: string
  detail?: string
  state: 'right' | 'wrong' | 'blank' | 'partial'
}

const MINISTRY = [0, 0.1, 0.25, 0.5, 1]

export default function ResultSummary({ cfg, answers, answerKey, compact }: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const sc = scorePaper(answers, answerKey, cfg)

  // Phần I
  const p1: Item[] = []
  for (let i = 0; i < cfg.n1; i++) {
    const a = answers.p1[i],
      k = answerKey.p1[i]
    p1.push(
      !a
        ? { label: `${i + 1}`, detail: `ĐA ${k || '?'}`, state: 'blank' }
        : a === k
          ? { label: `${i + 1}`, detail: a, state: 'right' }
          : { label: `${i + 1}`, detail: `${a} → ${k || '?'}`, state: 'wrong' },
    )
  }
  // Phần II: theo từng câu (số ý đúng /4) và từng ý
  const p2: Item[] = []
  let p2ItemsOk = 0
  for (let i = 0; i < cfg.n2; i++) {
    let k = 0
    const wrongSubs: string[] = []
    for (let j = 0; j < 4; j++) {
      const a = answers.p2[i]?.[j]
      if (typeof a === 'boolean' && a === answerKey.p2[i]?.[j]) k++
      else wrongSubs.push(`${TF_KEYS[j]}${a === null || a === undefined ? ' (trống)' : `: ${tfLabel(a)}→${tfLabel(answerKey.p2[i]?.[j])}`}`)
    }
    p2ItemsOk += k
    const pts = cfg.tfMethod === 'ministry_partial' ? cfg.p2 * MINISTRY[k] : (cfg.p2 * k) / 4
    p2.push({
      label: `${i + 1}`,
      detail: `${k}/4 ý · ${Math.round(pts * 100) / 100}đ${wrongSubs.length && wrongSubs.length < 4 ? ` · sai ${wrongSubs.join(', ')}` : ''}`,
      state: k === 4 ? 'right' : k === 0 ? 'wrong' : 'partial',
    })
  }
  // Phần III
  const p3: Item[] = []
  const showP3 = !skipsP3(cfg) && cfg.n3 > 0
  if (showP3)
    for (let i = 0; i < cfg.n3; i++) {
      const a = answers.p3[i],
        k = answerKey.p3[i]
      p3.push(
        !a
          ? { label: `${i + 1}`, detail: `ĐA ${k || '?'}`, state: 'blank' }
          : paperShortEqual(a, k || '')
            ? { label: `${i + 1}`, detail: a, state: 'right' }
            : { label: `${i + 1}`, detail: `${a} → ${k || '?'}`, state: 'wrong' },
      )
    }

  const count = (xs: Item[], s: Item['state']) => xs.filter((x) => x.state === s).length
  const all = [...p1, ...p2, ...p3]
  const totalRight = count(p1, 'right') + count(p2, 'right') + count(p3, 'right')
  const totalWrong = all.length - totalRight

  const keep = (x: Item) => filter === 'all' || (filter === 'right' ? x.state === 'right' : x.state !== 'right')

  const part = (title: string, items: Item[], score: number, extra: string, max: number) => {
    if (!items.length) return null
    const shown = items.filter(keep)
    return (
      <div className="rs-part">
        <div className="rs-head">
          <b>{title}</b>
          <span className="rs-count">
            <span className="badge correct">✓ {count(items, 'right')}</span>
            {count(items, 'partial') > 0 && <span className="badge partial">◐ {count(items, 'partial')}</span>}
            <span className="badge wrong">✗ {count(items, 'wrong')}</span>
            {count(items, 'blank') > 0 && <span className="badge warn">○ {count(items, 'blank')} trống</span>}
          </span>
          <span className="rs-score">
            {score}/{Math.round(max * 100) / 100}đ{extra}
          </span>
        </div>
        <div className="chips">
          {shown.map((x) => (
            <span key={x.label} className={`chip ${x.state}`} title={x.detail}>
              <b>{x.label}</b>
              {!compact && x.detail ? <small>{x.detail}</small> : null}
            </span>
          ))}
          {!shown.length && <span className="muted small">— không có —</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="result-summary">
      <div className="rs-top">
        <div className="rs-totals">
          <span className="badge correct">Đúng {totalRight}</span>
          <span className="badge wrong">Chưa đúng {totalWrong}</span>
          <span className="muted small">/{all.length} câu{showP3 ? '' : cfg.parts === 'p12' ? ' · Phần III không chấm' : ''}</span>
        </div>
        <div className="seg small">
          {(
            [
              ['all', 'Tất cả'],
              ['right', 'Câu đúng'],
              ['wrong', 'Câu sai'],
            ] as [Filter, string][]
          ).map(([k, l]) => (
            <button key={k} type="button" className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {part('Phần I', p1, sc.p1, '', cfg.n1 * cfg.p1)}
      {part('Phần II', p2, sc.p2, cfg.n2 ? ` · ${p2ItemsOk}/${cfg.n2 * 4} ý đúng` : '', cfg.n2 * cfg.p2)}
      {part('Phần III', p3, sc.p3, '', cfg.n3 * cfg.p3)}
    </div>
  )
}
