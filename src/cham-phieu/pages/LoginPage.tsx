import { FormEvent, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth'

function vnAuthError(msg: string): string {
  if (/invalid login credentials/i.test(msg)) return 'Sai email hoặc mật khẩu.'
  if (/email not confirmed/i.test(msg)) return 'Email chưa được xác nhận — mở hộp thư, bấm link xác nhận rồi đăng nhập lại.'
  if (/already registered|already been registered/i.test(msg)) return 'Email này đã đăng ký — hãy đăng nhập.'
  if (/at least 6 characters|password should be/i.test(msg)) return 'Mật khẩu tối thiểu 6 kí tự.'
  if (/rate limit|too many/i.test(msg)) return 'Thao tác quá nhiều lần, hãy thử lại sau ít phút.'
  return msg
}

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setOk('')
    const em = email.trim().toLowerCase()
    setBusy(true)
    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email: em, password })
        if (error) setErr(vnAuthError(error.message))
      } else if (mode === 'signup') {
        if (fullName.trim().length < 3) return setErr('Nhập họ và tên.')
        const { data, error } = await supabase.auth.signUp({
          email: em,
          password,
          options: { data: { full_name: fullName.trim() }, emailRedirectTo: `${window.location.origin}/cham-phieu` },
        })
        if (error) setErr(vnAuthError(error.message))
        else if (!data.session)
          setOk('Đã đăng ký. Mở hộp thư email, bấm link xác nhận, rồi chờ quản trị viên duyệt tài khoản.')
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(em, { redirectTo: `${window.location.origin}/cham-phieu` })
        if (error) setErr(vnAuthError(error.message))
        else setOk('Đã gửi email đặt lại mật khẩu. Mở email, bấm link rồi nhập mật khẩu mới.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container">
      <div className="card auth-box">
        <h2>{mode === 'login' ? 'Đăng nhập giáo viên' : mode === 'signup' ? 'Đăng ký tài khoản giáo viên' : 'Quên mật khẩu'}</h2>
        <p style={{ fontSize: 13.5 }}>Phần chấm phiếu chỉ dành cho giáo viên tổ Toán đã được quản trị viên duyệt.</p>
        <form onSubmit={submit}>
          {mode === 'signup' && (
            <>
              <label>Họ và tên</label>
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="VD: Nguyễn Thị A" required />
            </>
          )}
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          {mode !== 'forgot' && (
            <>
              <label>Mật khẩu</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={6}
                required
              />
            </>
          )}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Đang xử lý…' : mode === 'login' ? 'Đăng nhập' : mode === 'signup' ? 'Đăng ký' : 'Gửi email đặt lại'}
          </button>
        </form>
        {err && <p className="msg-err" style={{ marginTop: 10 }}>{err}</p>}
        {ok && <p className="msg-ok" style={{ marginTop: 10 }}>{ok}</p>}
        <p style={{ marginTop: 14, fontSize: 13.5 }}>
          {mode !== 'login' && (
            <a href="#" onClick={(e) => (e.preventDefault(), setMode('login'))}>
              Đăng nhập
            </a>
          )}
          {mode !== 'signup' && (
            <>
              {mode !== 'login' && ' · '}
              <a href="#" onClick={(e) => (e.preventDefault(), setMode('signup'))}>
                Chưa có tài khoản? Đăng ký
              </a>
            </>
          )}
          {mode !== 'forgot' && (
            <>
              {' · '}
              <a href="#" onClick={(e) => (e.preventDefault(), setMode('forgot'))}>
                Quên mật khẩu
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  )
}

/** Sau khi bấm link "đặt lại mật khẩu" trong email */
export function NewPasswordPage() {
  const { setRecovery } = useAuth()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (pw.length < 6) return setErr('Mật khẩu tối thiểu 6 kí tự.')
    if (pw !== pw2) return setErr('Hai lần nhập mật khẩu không khớp.')
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) return setErr(vnAuthError(error.message))
    setRecovery(false)
  }

  return (
    <div className="container">
      <div className="card auth-box">
        <h2>Đặt mật khẩu mới</h2>
        <form onSubmit={submit}>
          <label>Mật khẩu mới</label>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
          <label>Nhập lại mật khẩu mới</label>
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
          <button className="btn" disabled={busy}>
            {busy ? 'Đang lưu…' : 'Lưu mật khẩu'}
          </button>
        </form>
        {err && <p className="msg-err">{err}</p>}
      </div>
    </div>
  )
}
