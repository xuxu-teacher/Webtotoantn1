/**
 * Đăng nhập giáo viên tổ (Supabase Auth). Tài khoản tự đăng ký, quản trị viên duyệt mới dùng được.
 */
import { createContext, ReactNode, useContext, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, supabaseConfigured } from './lib/supabase'

export interface Teacher {
  id: string
  full_name: string
  email: string
  approved: boolean
  is_admin: boolean
}

interface AuthValue {
  session: Session | null
  teacher: Teacher | null
  /** đang tải phiên hoặc hồ sơ giáo viên */
  loading: boolean
  /** true khi vừa bấm link "quên mật khẩu" trong email -> phải đặt mật khẩu mới */
  recovery: boolean
  setRecovery: (v: boolean) => void
  reloadTeacher: () => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [teacher, setTeacher] = useState<Teacher | null>(null)
  const [loading, setLoading] = useState(true)
  const [checkedFor, setCheckedFor] = useState<string | null>(null) // id người dùng đã tải xong hồ sơ
  const [recovery, setRecovery] = useState(false)

  async function loadTeacher(s: Session | null) {
    if (!s) {
      setTeacher(null)
      setCheckedFor(null)
      return
    }
    const { data } = await supabase.from('teachers').select('id, full_name, email, approved, is_admin').eq('id', s.user.id).maybeSingle()
    setTeacher((data as Teacher) || null)
    setCheckedFor(s.user.id)
  }

  useEffect(() => {
    if (!supabaseConfigured) {
      setLoading(false)
      return
    }
    let alive = true
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return
      setSession(data.session)
      await loadTeacher(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      setSession(s)
      // không gọi Supabase trực tiếp trong callback (tránh treo phiên) — đẩy sang lượt sau
      setTimeout(() => loadTeacher(s), 0)
    })
    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const value: AuthValue = {
    session,
    teacher,
    loading: loading || (!!session && checkedFor !== session.user.id),
    recovery,
    setRecovery,
    reloadTeacher: () => loadTeacher(session),
    signOut: async () => {
      await supabase.auth.signOut()
      setTeacher(null)
      setSession(null)
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth phải dùng bên trong AuthProvider')
  return v
}
