/**
 * LƯU ẢNH PHIẾU VÀO GOOGLE DRIVE CỦA CHÍNH GIÁO VIÊN
 *
 * - Đăng nhập Google bằng Google Identity Services (cửa sổ của Google), quyền "drive.file":
 *   web CHỈ thấy và sửa được các file do chính web tạo ra, không xem được file khác trong Drive.
 * - Ảnh nằm trong thư mục "Chấm phiếu – ảnh bài làm / <tên đợt chấm>" ở Drive của giáo viên;
 *   bảng paper_sheets chỉ lưu mã file (image_drive_id, overlay_drive_id).
 * - Cần biến môi trường Vercel VITE_GOOGLE_CLIENT_ID (OAuth Client ID loại "Web application").
 *   Chưa khai báo -> chấm vẫn bình thường, chỉ không lưu ảnh.
 */

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || ''
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const ROOT_NAME = 'Chấm phiếu – ảnh bài làm'

export const driveConfigured = Boolean(CLIENT_ID)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gis = any

let gisPromise: Promise<Gis> | null = null
function loadGis(): Promise<Gis> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any
  if (w.google?.accounts?.oauth2) return Promise.resolve(w.google)
  if (!gisPromise)
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://accounts.google.com/gsi/client'
      s.async = true
      s.onload = () => (w.google?.accounts?.oauth2 ? resolve(w.google) : reject(new Error('Không tải được thư viện đăng nhập Google.')))
      s.onerror = () => {
        gisPromise = null
        reject(new Error('Không tải được thư viện đăng nhập Google (kiểm tra mạng).'))
      }
      document.head.appendChild(s)
    })
  return gisPromise
}

let token: { value: string; exp: number } | null = null
const listeners = new Set<(on: boolean) => void>()
function notify() {
  for (const f of listeners) f(driveConnected())
}

/** Đã có quyền ghi Drive còn hạn (token Google sống ~1 giờ) */
export function driveConnected(): boolean {
  return !!token && token.exp > Date.now() + 60_000
}

export function onDriveChange(f: (on: boolean) => void): () => void {
  listeners.add(f)
  return () => listeners.delete(f)
}

/**
 * Lấy quyền ghi Drive. PHẢI gọi ngay trong sự kiện bấm nút (trình duyệt chặn cửa sổ bật lên nếu không).
 * Lần đầu hiện cửa sổ chọn tài khoản + đồng ý; các lần sau (token hết hạn) thường tự cấp lại không cần bấm.
 */
export async function connectDrive(emailHint?: string): Promise<string> {
  if (!CLIENT_ID) throw new Error('Web chưa cấu hình Google Drive (thiếu VITE_GOOGLE_CLIENT_ID).')
  if (driveConnected()) return token!.value
  const google = await loadGis()
  return new Promise<string>((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      hint: emailHint,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callback: (r: any) => {
        if (r?.error || !r?.access_token) return reject(new Error(`Google từ chối cấp quyền: ${r?.error_description || r?.error || 'không rõ lý do'}`))
        if (!String(r.scope || '').includes('drive.file')) return reject(new Error('Chưa tích chọn quyền "xem, tạo, sửa file do ứng dụng tạo" của Google Drive.'))
        token = { value: r.access_token, exp: Date.now() + Number(r.expires_in || 3600) * 1000 }
        notify()
        resolve(r.access_token)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error_callback: (e: any) =>
        reject(new Error(e?.type === 'popup_closed' ? 'Đã đóng cửa sổ đăng nhập Google.' : e?.type === 'popup_failed_to_open' ? 'Trình duyệt chặn cửa sổ đăng nhập Google — cho phép cửa sổ bật lên rồi bấm lại.' : 'Không đăng nhập được Google.')),
    })
    client.requestAccessToken({ prompt: token ? '' : 'select_account' })
  })
}

export function disconnectDrive() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const google = (window as any).google
  if (token && google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.value, () => {})
  token = null
  notify()
}

async function api(url: string, init: RequestInit = {}): Promise<Response> {
  if (!driveConnected()) throw new Error('Phiên Google Drive đã hết hạn — bấm "Kết nối Google Drive" lại.')
  const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token!.value}` } })
  if (r.status === 401) {
    token = null
    notify()
    throw new Error('Phiên Google Drive đã hết hạn — bấm "Kết nối Google Drive" lại.')
  }
  if (!r.ok) {
    const j = await r.json().catch(() => null)
    throw new Error(`Google Drive báo lỗi: ${j?.error?.message || r.status}`)
  }
  return r
}

const folderCache = new Map<string, string>()

async function ensureFolder(name: string, parent?: string): Promise<string> {
  const ck = `${parent || 'root'}/${name}`
  const hit = folderCache.get(ck)
  if (hit) return hit
  const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const q = `name='${esc}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parent ? ` and '${parent}' in parents` : ''}`
  const found = await (await api(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`)).json()
  let id: string | undefined = found?.files?.[0]?.id
  if (!id) {
    const made = await (
      await api('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }),
      })
    ).json()
    id = made.id as string
  }
  folderCache.set(ck, id)
  return id
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'image/jpeg'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

/** Tải 1 ảnh (data URL) vào thư mục của đợt chấm; trả về mã file Drive */
export async function uploadImage(batchTitle: string, fileName: string, dataUrl: string): Promise<string> {
  const root = await ensureFolder(ROOT_NAME)
  const folder = await ensureFolder(batchTitle.trim() || 'Đợt chấm', root)
  const meta = { name: fileName.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150), parents: [folder] }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }))
  form.append('file', dataUrlToBlob(dataUrl))
  const r = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form })
  return (await r.json()).id as string
}

export const driveViewUrl = (id: string) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`
