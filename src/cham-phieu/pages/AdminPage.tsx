import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Teacher, useAuth } from '../auth'

interface Row extends Teacher {
  created_at: string
}

/** Quản trị viên duyệt / khoá tài khoản giáo viên trong tổ */
export default function AdminPage() {
  const { teacher: me } = useAuth()
  const [rows, setRows] = useState<Row[]>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const { data, error } = await supabase
      .from('teachers')
      .select('id, full_name, email, approved, is_admin, created_at')
      .order('approved', { ascending: true })
      .order('created_at', { ascending: false })
    if (error) setErr(error.message)
    setRows((data as Row[]) || [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function patch(r: Row, p: Partial<Pick<Teacher, 'approved' | 'is_admin'>>) {
    const { error } = await supabase.from('teachers').update(p).eq('id', r.id)
    if (error) return alert(error.message)
    load()
  }

  async function remove(r: Row) {
    if (!confirm(`Xoá hồ sơ giáo viên ${r.full_name || r.email}? Toàn bộ đợt chấm của giáo viên này cũng bị xoá.`)) return
    const { error } = await supabase.from('teachers').delete().eq('id', r.id)
    if (error) return alert(error.message)
    load()
  }

  const pending = rows.filter((r) => !r.approved)

  return (
    <div className="container">
      <h1>🔑 Duyệt tài khoản giáo viên</h1>
      <p>
        Giáo viên tự đăng ký ở trang Chấm phiếu, sau đó cô bấm <b>Duyệt</b> ở đây. Bấm <b>Khoá</b> để tạm dừng quyền dùng.
        {pending.length > 0 && <span className="badge warn" style={{ marginLeft: 8 }}>{pending.length} tài khoản chờ duyệt</span>}
      </p>
      {err && <p className="msg-err">{err}</p>}
      <div className="card">
        {loading ? (
          <p>Đang tải…</p>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Họ và tên</th>
                <th>Email</th>
                <th>Đăng ký</th>
                <th>Trạng thái</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.full_name || '—'} {r.is_admin && <span className="badge">Quản trị</span>}
                  </td>
                  <td>{r.email}</td>
                  <td>{new Date(r.created_at).toLocaleDateString('vi-VN')}</td>
                  <td>{r.approved ? <span className="badge correct">Đã duyệt</span> : <span className="badge warn">Chờ duyệt</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.id === me?.id ? (
                      <span style={{ color: 'var(--muted)', fontSize: 13 }}>(tài khoản của cô)</span>
                    ) : (
                      <>
                        {r.approved ? (
                          <button className="btn secondary" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => patch(r, { approved: false })}>
                            Khoá
                          </button>
                        ) : (
                          <button className="btn" style={{ padding: '3px 12px', fontSize: 12 }} onClick={() => patch(r, { approved: true })}>
                            Duyệt
                          </button>
                        )}{' '}
                        <button
                          className="btn secondary"
                          style={{ padding: '3px 10px', fontSize: 12 }}
                          onClick={() => patch(r, { is_admin: !r.is_admin })}
                          title="Quản trị viên được duyệt / khoá tài khoản khác"
                        >
                          {r.is_admin ? 'Bỏ quyền quản trị' : 'Cho làm quản trị'}
                        </button>{' '}
                        <button className="btn danger" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => remove(r)}>
                          Xoá
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
