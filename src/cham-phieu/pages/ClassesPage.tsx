import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { stripVN } from '../utils/omr'

interface ClassRow {
  id: string
  class_name: string
}
interface StudentRow {
  id: string
  class_id: string
  stt: number | null
  full_name: string
  student_code: string | null
}

/**
 * Dán danh sách lớp: mỗi dòng 1 học sinh. Chấp nhận "Nguyễn Văn An", "1. Nguyễn Văn An",
 * hoặc dán thẳng từ Excel (STT ⇥ Họ và tên ⇥ ...). Họ đệm và Tên tách 2 cột thì cần ghép thành 1 cột trước.
 */
export function parseRoster(text: string): { stt: number; full_name: string }[] {
  const out: { stt: number; full_name: string }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const cells = raw.split('\t').map((c) => c.trim())
    let name = ''
    if (cells.filter(Boolean).length <= 1) {
      // một ô: "12. Nguyễn Văn An" / "Nguyễn Văn An"
      name = (cells.find(Boolean) || '').replace(/^\s*\d+\s*[.)\-:]?\s*/, '')
    } else {
      // dán nhiều cột từ Excel (STT ⇥ Họ và tên ⇥ Ngày sinh…): lấy ô chữ đầu tiên
      name = cells.find((c) => /\p{L}/u.test(c) && !/^\d/.test(c)) || ''
    }
    name = name.replace(/\s+/g, ' ').trim()
    const key = stripVN(name)
    if (!name || !/\p{L}/u.test(name) || /^(stt|ho va ten|ho ten|ho dem|danh sach)/.test(key)) continue
    out.push({ stt: out.length + 1, full_name: name })
  }
  return out
}

export default function ClassesPage() {
  const [classes, setClasses] = useState<ClassRow[]>([])
  const [students, setStudents] = useState<StudentRow[]>([])
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState<{ id?: string; name: string; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  async function load() {
    const [c, s] = await Promise.all([
      supabase.from('classes').select('id, class_name').order('class_name'),
      supabase.from('students').select('id, class_id, stt, full_name, student_code').order('stt'),
    ])
    if (c.error) setErr(c.error.message)
    setClasses((c.data as ClassRow[]) || [])
    setStudents((s.data as StudentRow[]) || [])
  }
  useEffect(() => {
    load()
  }, [])

  const listOf = (id: string) => students.filter((s) => s.class_id === id)

  async function save() {
    if (!edit) return
    const name = edit.name.trim()
    if (!name) return setErr('Nhập tên lớp.')
    const parsed = parseRoster(edit.text)
    setSaving(true)
    setErr('')
    try {
      let classId = edit.id
      if (!classId) {
        const { data, error } = await supabase.from('classes').insert({ class_name: name }).select('id').single()
        if (error) throw error
        classId = data.id as string
      } else {
        const { error } = await supabase.from('classes').update({ class_name: name }).eq('id', classId)
        if (error) throw error
      }
      // Giữ nguyên mã học sinh cũ khi trùng tên (để không mất liên kết với phiếu đã chấm)
      const old = listOf(classId)
      const used = new Set<string>()
      const updates: { id: string; stt: number; full_name: string }[] = []
      const inserts: { class_id: string; stt: number; full_name: string }[] = []
      for (const p of parsed) {
        const m = old.find((o) => !used.has(o.id) && stripVN(o.full_name) === stripVN(p.full_name))
        if (m) {
          used.add(m.id)
          updates.push({ id: m.id, stt: p.stt, full_name: p.full_name })
        } else inserts.push({ class_id: classId, stt: p.stt, full_name: p.full_name })
      }
      const removed = old.filter((o) => !used.has(o.id)).map((o) => o.id)
      if (removed.length) {
        const { error } = await supabase.from('students').delete().in('id', removed)
        if (error) throw error
      }
      for (const u of updates) {
        const { error } = await supabase.from('students').update({ stt: u.stt, full_name: u.full_name }).eq('id', u.id)
        if (error) throw error
      }
      if (inserts.length) {
        const { error } = await supabase.from('students').insert(inserts)
        if (error) throw error
      }
      setEdit(null)
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(c: ClassRow) {
    if (!confirm(`Xoá lớp ${c.class_name} và danh sách học sinh? (Phiếu đã chấm vẫn giữ họ tên.)`)) return
    const { error } = await supabase.from('classes').delete().eq('id', c.id)
    if (error) return alert(error.message)
    load()
  }

  const preview = edit ? parseRoster(edit.text) : []

  return (
    <div className="container">
      <h1>👥 Lớp &amp; danh sách học sinh</h1>
      <p>Dùng cho phiếu lớp (do web tạo): máy khớp họ tên + STT học sinh viết trên phiếu với danh sách này. Phiếu trường (cắt phách) không cần.</p>
      {err && <p className="msg-err">{err}</p>}
      {edit ? (
        <div className="card">
          <h2>{edit.id ? 'Sửa lớp' : 'Thêm lớp'}</h2>
          <label>Tên lớp</label>
          <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="VD: 10A1" style={{ maxWidth: 240 }} />
          <label>Danh sách học sinh — mỗi dòng 1 em, đúng thứ tự STT (dán từ Excel được)</label>
          <textarea rows={14} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} placeholder={'Nguyễn Văn An\nTrần Thị Bình\n...'} />
          <p style={{ fontSize: 13 }}>
            Đọc được <b>{preview.length}</b> học sinh
            {preview.length > 0 && `: ${preview.slice(0, 3).map((p) => `${p.stt}. ${p.full_name}`).join('; ')}${preview.length > 3 ? '; …' : ''}`}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={save} disabled={saving}>
              {saving ? 'Đang lưu…' : 'Lưu lớp'}
            </button>
            <button className="btn secondary" onClick={() => setEdit(null)}>
              Huỷ
            </button>
          </div>
        </div>
      ) : (
        <button className="btn" onClick={() => setEdit({ name: '', text: '' })} style={{ marginBottom: 16 }}>
          + Thêm lớp
        </button>
      )}
      <div className="card">
        <table className="list">
          <thead>
            <tr>
              <th>Lớp</th>
              <th>Sĩ số</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {classes.map((c) => (
              <tr key={c.id}>
                <td>{c.class_name}</td>
                <td>{listOf(c.id).length}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button
                    className="btn secondary"
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    onClick={() => setEdit({ id: c.id, name: c.class_name, text: listOf(c.id).map((s) => s.full_name).join('\n') })}
                  >
                    Sửa
                  </button>{' '}
                  <button className="btn danger" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => remove(c)}>
                    Xoá
                  </button>
                </td>
              </tr>
            ))}
            {!classes.length && (
              <tr>
                <td colSpan={3} style={{ color: 'var(--muted)' }}>
                  Chưa có lớp nào.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
