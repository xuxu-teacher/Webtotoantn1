import { createClient } from '@supabase/supabase-js'

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || ''
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || ''

/** false = chưa khai báo biến môi trường Supabase trên Vercel */
export const supabaseConfigured = Boolean(url && anonKey)

// Thiếu cấu hình vẫn tạo client giả để trang không trắng — giao diện sẽ báo cần khai báo biến môi trường
export const supabase = createClient(url || 'https://chua-cau-hinh.supabase.co', anonKey || 'chua-cau-hinh')
