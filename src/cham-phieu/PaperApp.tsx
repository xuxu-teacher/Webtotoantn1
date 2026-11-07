/**
 * Khu "Chấm phiếu" của web tổ Toán: /cham-phieu/...
 * Chỉ giáo viên đã đăng nhập VÀ đã được quản trị viên duyệt mới dùng được.
 */
import { Link, Navigate, Route, Routes } from 'react-router-dom'
import './paper.css'
import { AuthProvider, useAuth } from './auth'
import { supabaseConfigured } from './lib/supabase'
import LoginPage, { NewPasswordPage } from './pages/LoginPage'
import AdminPage from './pages/AdminPage'
import ClassesPage from './pages/ClassesPage'
import BatchList from './pages/BatchList'
import BatchDetail from './pages/BatchDetail'

export default function PaperApp() {
  return (
    <AuthProvider>
      <div className="pg">
        <Gate />
      </div>
    </AuthProvider>
  )
}

function TopBar() {
  const { teacher, session, signOut } = useAuth()
  return (
    <header className="pg-top">
      <nav>
        <a href="/">← Soạn KHBD</a>
        {teacher?.approved && (
          <>
            <Link to="/cham-phieu">📷 Chấm phiếu</Link>
            <Link to="/cham-phieu/lop">👥 Lớp &amp; học sinh</Link>
            {teacher.is_admin && <Link to="/cham-phieu/quan-tri">🔑 Duyệt giáo viên</Link>}
          </>
        )}
      </nav>
      {session && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="who">{teacher?.full_name || session.user.email}</span>
          <button onClick={signOut}>Đăng xuất</button>
        </div>
      )}
    </header>
  )
}

function Gate() {
  const { session, teacher, loading, recovery } = useAuth()

  if (!supabaseConfigured)
    return (
      <div className="container">
        <div className="card">
          <h2>Chưa cấu hình máy chủ đăng nhập</h2>
          <p>
            Cần khai báo <code>VITE_SUPABASE_URL</code> và <code>VITE_SUPABASE_ANON_KEY</code> trong Vercel → Project Settings →
            Environment Variables rồi bấm Redeploy (xem file HUONG_DAN_CHAM_PHIEU.md).
          </p>
        </div>
      </div>
    )
  if (loading)
    return (
      <div className="container">
        <p>Đang tải…</p>
      </div>
    )
  if (recovery && session)
    return (
      <>
        <TopBar />
        <NewPasswordPage />
      </>
    )
  if (!session)
    return (
      <>
        <TopBar />
        <LoginPage />
      </>
    )
  if (!teacher || !teacher.approved) return <Waiting />

  return (
    <>
      <TopBar />
      <Routes>
        <Route index element={<BatchList />} />
        <Route path="lop" element={<ClassesPage />} />
        <Route path="quan-tri" element={teacher.is_admin ? <AdminPage /> : <Navigate to="/cham-phieu" replace />} />
        <Route path=":batchId" element={<BatchDetail />} />
        <Route path="*" element={<Navigate to="/cham-phieu" replace />} />
      </Routes>
    </>
  )
}

function Waiting() {
  const { teacher, session, reloadTeacher } = useAuth()
  return (
    <>
      <TopBar />
      <div className="container">
        <div className="card auth-box">
          <h2>Tài khoản đang chờ duyệt</h2>
          <p>
            Tài khoản <b>{teacher?.email || session?.user.email}</b> đã đăng ký. Quản trị viên của tổ cần bấm <b>Duyệt</b> thì cô/thầy
            mới dùng được phần chấm phiếu.
          </p>
          {!teacher && (
            <p className="msg-err">Chưa thấy hồ sơ giáo viên trên máy chủ — quản trị viên cần chạy file supabase/schema_cham_phieu.sql.</p>
          )}
          <button className="btn secondary" onClick={reloadTeacher}>
            Kiểm tra lại
          </button>
        </div>
      </div>
    </>
  )
}
