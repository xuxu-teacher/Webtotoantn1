/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** OAuth Client ID (Google Cloud, loại Web application) để lưu ảnh phiếu vào Google Drive của giáo viên */
  readonly VITE_GOOGLE_CLIENT_ID?: string
}
