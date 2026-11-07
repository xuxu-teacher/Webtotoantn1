import { CSSProperties } from 'react'
import { CellId, PaperAnswers, PaperConfig, TF_KEYS, tfLabel } from '../utils/omr'

interface Props {
  cfg: PaperConfig
  value: PaperAnswers
  onChange?: (v: PaperAnswers) => void // không truyền = chỉ xem
  flags?: Record<CellId, string> // ô AI không chắc -> tô vàng
  correct?: Record<CellId, boolean> // đúng/sai so với đáp án -> tô xanh/đỏ
  answerKey?: PaperAnswers // hiện đáp án đúng khi rê chuột vào ô sai
}

const cellBase: CSSProperties = { border: '1px solid var(--border-strong)', padding: 4, textAlign: 'center', minWidth: 44 }
const headBase: CSSProperties = { ...cellBase, background: 'var(--primary-light)', fontWeight: 700, fontSize: 12.5 }
const inputBase: CSSProperties = {
  width: '100%',
  minWidth: 40,
  padding: '4px 2px',
  textAlign: 'center',
  fontWeight: 700,
  fontSize: 15,
  border: '1px solid transparent',
  background: 'transparent',
  margin: 0,
}

function cellStyle(id: CellId, flags?: Record<CellId, string>, correct?: Record<CellId, boolean>): CSSProperties {
  if (flags?.[id]) return { ...cellBase, background: '#fef3c7', outline: '2px solid #f59e0b', outlineOffset: -2 }
  if (correct && id in correct) return { ...cellBase, background: correct[id] ? '#dcfce7' : '#fee2e2' }
  return cellBase
}

export default function PaperAnswerGrid({ cfg, value, onChange, flags, correct, answerKey }: Props) {
  const ro = !onChange
  const tip = (id: CellId, right: string) =>
    [flags?.[id], correct && correct[id] === false && answerKey ? `Đáp án: ${right || '(trống)'}` : '']
      .filter(Boolean)
      .join(' — ') || undefined

  const setP1 = (i: number, v: string) => {
    const p1 = [...value.p1]
    p1[i] = v || null
    onChange?.({ ...value, p1 })
  }
  const setP2 = (i: number, j: number, v: string) => {
    const p2 = value.p2.map((r) => [...r])
    p2[i][j] = v === 'Đ' ? true : v === 'S' ? false : null
    onChange?.({ ...value, p2 })
  }
  const setP3 = (i: number, v: string) => {
    const p3 = [...value.p3]
    p3[i] = v.trim() ? v.trim() : null
    onChange?.({ ...value, p3 })
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      {cfg.n1 > 0 && (
        <>
          <b>Phần 1.</b>
          <table style={{ borderCollapse: 'collapse', margin: '4px 0 12px' }}>
            <tbody>
              <tr>
                {value.p1.map((_, i) => (
                  <td key={i} style={headBase}>
                    Câu {i + 1}
                  </td>
                ))}
              </tr>
              <tr>
                {value.p1.map((v, i) => {
                  const id = `1.${i + 1}`
                  return (
                    <td key={i} style={cellStyle(id, flags, correct)} title={tip(id, answerKey?.p1[i] || '')}>
                      {ro ? (
                        <b>{v || ''}</b>
                      ) : (
                        <select value={v || ''} onChange={(e) => setP1(i, e.target.value)} style={inputBase}>
                          <option value=""></option>
                          {['A', 'B', 'C', 'D'].map((x) => (
                            <option key={x} value={x}>
                              {x}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                  )
                })}
              </tr>
            </tbody>
          </table>
        </>
      )}

      {cfg.n2 > 0 && (
        <>
          <b>Phần 2.</b> <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>(Đ = Đúng, S = Sai)</span>
          <table style={{ borderCollapse: 'collapse', margin: '4px 0 12px' }}>
            <tbody>
              <tr>
                <td style={headBase}>Ý</td>
                {value.p2.map((_, i) => (
                  <td key={i} style={{ ...headBase, minWidth: 70 }}>
                    Câu {i + 1}
                  </td>
                ))}
              </tr>
              {TF_KEYS.map((k, j) => (
                <tr key={k}>
                  <td style={headBase}>{k})</td>
                  {value.p2.map((row, i) => {
                    const id = `2.${i + 1}${k}`
                    return (
                      <td key={i} style={cellStyle(id, flags, correct)} title={tip(id, tfLabel(answerKey?.p2[i]?.[j]))}>
                        {ro ? (
                          <b>{tfLabel(row[j])}</b>
                        ) : (
                          <select value={tfLabel(row[j])} onChange={(e) => setP2(i, j, e.target.value)} style={inputBase}>
                            <option value=""></option>
                            <option value="Đ">Đ</option>
                            <option value="S">S</option>
                          </select>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {cfg.n3 > 0 && (
        <>
          <b>Phần 3.</b>
          <table style={{ borderCollapse: 'collapse', margin: '4px 0 4px' }}>
            <tbody>
              <tr>
                {value.p3.map((_, i) => (
                  <td key={i} style={{ ...headBase, minWidth: 70 }}>
                    Câu {i + 1}
                  </td>
                ))}
              </tr>
              <tr>
                {value.p3.map((v, i) => {
                  const id = `3.${i + 1}`
                  return (
                    <td key={i} style={cellStyle(id, flags, correct)} title={tip(id, answerKey?.p3[i] || '')}>
                      {ro ? (
                        <b>{v || ''}</b>
                      ) : (
                        <input
                          value={v || ''}
                          onChange={(e) => setP3(i, e.target.value)}
                          style={{ ...inputBase, width: 70 }}
                          inputMode="decimal"
                        />
                      )}
                    </td>
                  )
                })}
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
