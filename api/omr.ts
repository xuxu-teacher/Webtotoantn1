/**
 * Vercel Serverless Function (web tổ Toán): ĐỌC CHỮ VIẾT TAY / BẢNG ĐÁP ÁN cho phần Chấm phiếu.
 * Chỉ giáo viên đã đăng nhập VÀ đã được quản trị viên duyệt (bảng teachers.approved) mới gọi được.
 * Nhận 1 ảnh phiếu (JPEG base64), gọi AI đọc chữ viết tay, trả JSON thô.
 * Việc chuẩn hoá + chấm điểm làm ở trình duyệt (src/utils/omr.ts) để giáo viên rà lại.
 *
 * Dùng chung biến môi trường với api/gemini.ts:
 *   GEMINI_API_KEY, GEMINI_MODELS (tuỳ chọn), ANTHROPIC_API_KEY (tuỳ chọn), CLAUDE_MODEL (tuỳ chọn)
 *   OMR_MODELS (tuỳ chọn) – danh sách model riêng cho chấm phiếu, ưu tiên hơn GEMINI_MODELS
 *
 * Body: { image: base64, mode: 'key'|'sheet'|'fields'|'keytable', kind?: 'school'|'class', n1, n2, n3, modelOffset?: number,
 *         text?: string (lớp chữ của trang PDF bảng đáp án, nếu có) }
 *   modelOffset = 1: bắt đầu từ model thứ hai trong danh sách (dùng cho lần đọc đối chiếu)
 * Trả về: { data, provider, model }
 */

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env

const DEFAULT_GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash']
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: any }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: (code: number) => Res; json: (data: any) => void; setHeader: (k: string, v: string) => void }

interface AiAttempt {
  ok: boolean
  text?: string
  status?: number
  error?: string
}

/** Giáo viên đã đăng nhập và đã được duyệt? (đọc bảng teachers bằng chính phiên của giáo viên — RLS cho xem dòng của mình) */
async function verifyTeacher(authHeader: string | undefined): Promise<'ok' | 'login' | 'pending' | 'config'> {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const anon = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
  if (!url || !anon) return 'config'
  if (!authHeader?.startsWith('Bearer ')) return 'login'
  const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: authHeader } })
  if (!r.ok) return 'login'
  const user = (await r.json().catch(() => null)) as { id?: string } | null
  if (!user?.id) return 'login'
  const t = await fetch(`${url}/rest/v1/teachers?select=approved&id=eq.${encodeURIComponent(user.id)}`, {
    headers: { apikey: anon, Authorization: authHeader },
  })
  const rows = (await t.json().catch(() => null)) as { approved?: boolean }[] | null
  return t.ok && Array.isArray(rows) && rows[0]?.approved === true ? 'ok' : 'pending'
}

function systemPrompt(n1: number, n2: number, n3: number, mode: 'key' | 'sheet'): string {
  const who = mode === 'key' ? 'giáo viên ghi ĐÁP ÁN' : 'học sinh ghi BÀI LÀM'
  return `Bạn là máy đọc phiếu trả lời trắc nghiệm môn Toán (đề thi THPT Việt Nam), chữ ${who} viết tay bằng bút.
Nhiệm vụ DUY NHẤT: chép lại CHÍNH XÁC những gì được viết trong từng ô. KHÔNG giải toán, KHÔNG đoán đáp án đúng, KHÔNG tự sửa.

CẤU TRÚC PHIẾU (từ trên xuống)
- Phần đầu (nếu có): Họ và tên, Lớp, Mã đề (viết tay).
- "Phần 1": bảng 2 hàng × ${n1} cột. Hàng trên in sẵn "Câu 1" … "Câu ${n1}"; hàng dưới là chữ cái viết tay A, B, C hoặc D.
- "Phần 2": bảng có ${n2} cột "Câu 1" … "Câu ${n2}". Dưới hàng tiêu đề có 4 hàng, TỪ TRÊN XUỐNG lần lượt là ý a), b), c), d) (có thể có hoặc không có cột nhãn a, b, c, d bên trái).
  Mỗi ô ghi "Đ" hoặc "S", hoặc ghi đầy đủ "Đúng" hoặc "Sai". Chữ Đ viết tay thường có nét gạch ngang, dễ nhìn giống D hoặc A; chữ S viết tay dễ nhìn giống số 5 hoặc chữ s thường.
- "Phần 3": bảng 2 hàng × ${n3} cột "Câu 1" … "Câu ${n3}"; hàng dưới là đáp số viết tay (số nguyên hoặc số thập phân, có thể có dấu trừ "-" và dấu phẩy ",").

QUY TẮC ĐỌC
1. Xác định ô theo KẺ BẢNG và cột "Câu …". Chữ viết lệch, tràn qua đường kẻ hoặc nằm giữa hai hàng: gán vào ô mà phần lớn nét chữ nằm trong, và đưa ô đó vào "uncertain".
2. Ô trống, chỉ có vết bẩn/chấm mực: ghi "" (chuỗi rỗng). Không bao giờ tự điền.
3. Có gạch xoá rồi viết lại: lấy chữ viết sau cùng (chữ không bị gạch). Nếu không phân biệt được chữ nào là chữ cuối, hoặc trong ô có hai đáp án: chép chữ dễ thấy nhất và đưa ô vào "uncertain".
4. Phần 1: ghi đúng một chữ cái in hoa "A"/"B"/"C"/"D".
5. Phần 2: chép đúng như viết: "Đ", "S", "Đúng" hoặc "Sai". Không đổi sang true/false.
6. Phần 3: chép nguyên đáp số, giữ dấu "-" và dấu "," ; không làm tròn, không đổi dấu phẩy thành dấu chấm. Chú ý phân biệt 1 và 7, 4 và 9, 0 và 6, 5 và S, dấu trừ và nét gạch chân.
7. Mọi ô bạn không chắc chắn ≥ 95% đều phải có trong "uncertain", ghi theo mã: "P1.<câu>", "P2.<câu><ý>" (ví dụ "P2.3b"), "P3.<câu>".
8. Không đọc được Họ tên/Lớp/Mã đề thì để "".
9. Ảnh có thể chụp nghiêng, lệch sáng, có bàn phím hay giấy khác lọt vào khung: chỉ đọc phiếu trả lời chính.

CHỈ TRẢ VỀ JSON đúng dạng sau (mảng p1 có đúng ${n1} phần tử, p2 có đúng ${n2} mảng con, mỗi mảng con 4 phần tử theo thứ tự a,b,c,d; p3 có đúng ${n3} phần tử):
{"ho_ten":"","lop":"","ma_de":"","p1":["A",...],"p2":[["Đ","S","Đúng",""],...],"p3":["-1",...],"uncertain":["P1.9"],"ghi_chu":""}`
}

/** Phiếu tô ô: chỉ còn các ô VIẾT TAY (thông tin đầu phiếu + Phần III) cần AI đọc */
function fieldsPrompt(kind: 'school' | 'class', n3: number): string {
  const header =
    kind === 'school'
      ? `- PHẦN TRÊN: đầu phiếu của trường gồm các ô "MÃ ĐỀ", "Mã phách", "Điểm TN", "Điểm TL", "Tổng điểm", "Số phách", "Số tờ".
  CHỈ đọc 3 ô: "MÃ ĐỀ" -> ma_de; "Mã phách" -> ma_phach (thường gồm chữ và số, VD "T106"); "Số phách" -> so_phach (thường là số, có thể viết mực đỏ, VD "01").
  KHÔNG đọc Điểm TN, Điểm TL, Tổng điểm, Số tờ.`
      : `- PHẦN TRÊN: hàng ô "Họ và tên", "STT", "Lớp", "Mã đề" (học sinh viết tay). Đọc lần lượt -> ho_ten, stt, lop, ma_de.
  Họ tên tiếng Việt: chép đủ dấu, viết hoa chữ cái đầu mỗi từ.`
  const p3 =
    kind === 'school'
      ? `- PHẦN DƯỚI: "PHẦN III." với dòng "Câu 1. ...... Câu 2. ...... … Câu 8. ......": đáp số viết tay trên dòng chấm ngay SAU chữ "Câu k." là đáp án câu k.`
      : `- PHẦN DƯỚI: "PHẦN III." gồm các ô có nhãn "Câu 1" … "Câu ${n3}" ở trên; đáp số viết trong ô.`
  return `Bạn là máy đọc chữ viết tay trên phiếu trả lời trắc nghiệm môn Toán (THPT Việt Nam).
Ảnh gồm 2 phần đã cắt từ phiếu và nắn thẳng. Nhiệm vụ DUY NHẤT: chép lại CHÍNH XÁC chữ/số viết tay. KHÔNG giải toán, KHÔNG đoán, KHÔNG tự sửa.

${header}
${p3}
  Chỉ đọc ${n3} câu đầu (Câu 1 … Câu ${n3}). Đáp số là số nguyên, số thập phân (dấu phẩy ","), có thể có dấu trừ "-".
  Học sinh có thể viết PHÂN SỐ: kiểu gạch ngang (13/4), hoặc tử số viết TRÊN, mẫu số viết DƯỚI một vạch ngang ngắn
  (VD số 13 ở trên, số 4 ở dưới) -> chép thành "13/4"; phân số âm -> "-13/4". KHÔNG tự tính ra số thập phân.
  Ô/dòng trống -> "".

QUY TẮC
1. Chú ý phân biệt 1 và 7, 4 và 9, 0 và 6, 5 và S, dấu phẩy và vết bẩn, dấu trừ và nét gạch chân/đường chấm in sẵn.
2. Có gạch xoá rồi viết lại: lấy phần viết sau cùng (không bị gạch).
3. Chữ in sẵn trên phiếu (nhãn, dấu chấm) không phải bài làm.
4. Mọi ô bạn không chắc ≥ 95% phải có trong "uncertain" theo mã: "P3.<câu>", "MA_DE", "MA_PHACH", "SO_PHACH", "HO_TEN", "STT", "LOP".

CHỈ TRẢ VỀ JSON (p3 có đúng ${n3} phần tử):
{"ma_de":"","ma_phach":"","so_phach":"","ho_ten":"","stt":"","lop":"","p3":["",...],"uncertain":[],"ghi_chu":""}`
}

/** Ảnh/trang PDF có BẢNG ĐÁP ÁN của đề (một hoặc nhiều mã đề) */
function keyTablePrompt(n1: number, n2: number, n3: number, hasText: boolean): string {
  return `Bạn đọc BẢNG ĐÁP ÁN của đề kiểm tra môn Toán THPT (Việt Nam). KHÔNG giải toán, CHỈ chép đáp án có sẵn. Sai một ô là cả lớp bị chấm sai, nên phải cực kì cẩn thận.
Đề có 3 phần: Phần I ${n1} câu trắc nghiệm 4 phương án (A/B/C/D); Phần II ${n2} câu Đúng/Sai, mỗi câu 4 ý a), b), c), d); Phần III ${n3} câu trả lời ngắn (đáp số).
${
  hasText
    ? `Kèm theo ảnh là LỚP CHỮ trích từ chính trang PDF đó (dấu " | " ngăn cách các ô bảng nằm cùng hàng). Lớp chữ chính xác tuyệt đối về kí tự: chép kí tự theo lớp chữ, dùng ảnh để hiểu bố cục bảng (ô nào thuộc câu nào, ý nào, mã đề nào).`
    : 'Chỉ có ảnh (trang scan / ảnh chụp).'
}

CÁCH XÁC ĐỊNH ĐÚNG Ô
1. Tìm nhãn của từng hàng và từng cột ("Câu", "Mã đề", "a", "b", "c", "d", "Ý"...). Bảng có thể NẰM NGANG (hàng = câu) hoặc NẰM DỌC/CHUYỂN VỊ
   (cột = câu, hàng = ý a, b, c, d) — xác định theo nhãn, KHÔNG đoán theo vị trí.
2. Phần I: các kiểu "1C 2D 3A", "1.C", bảng 2 hàng (hàng trên số câu, hàng dưới đáp án), nhiều mã đề mỗi mã một hàng/cột. Đếm lại số câu cho khớp nhãn.
3. Phần II: các kiểu "Câu 1: a) Đ b) S c) S d) Đ", "a-Đ, b-S", "ĐSSĐ" (theo thứ tự a,b,c,d), "Đúng/Sai", "Đ/S", "T/F", bảng có cột ý a,b,c,d,
   hoặc bảng mỗi câu chiếm 4 dòng a), b), c), d). Không được hoán đổi các ý, không được lệch sang câu bên cạnh.
4. Phần III: chép đáp số, giữ dấu "-" và dấu phẩy thập phân; phân số chép dạng "a/b".
5. Nhiều mã đề: mỗi mã đề một phần tử trong "keys". Không thấy mã đề thì ma_de = "".
6. Câu không có trong ảnh -> "" (KHÔNG tự điền). Ảnh không có bảng đáp án -> "keys": [].

KIỂM TRA CHÉO (bắt buộc)
- "p1_raw": chép NGUYÊN VĂN phần đáp án Phần I theo dạng "số câu + chữ cái", VD "1C 2D 3A ... ${n1}B" (ghép từ bảng nếu bảng tách hàng số câu và hàng đáp án).
- "p2_raw": mảng ${n2} chuỗi, chuỗi thứ k chép NGUYÊN VĂN đáp án câu k Phần II kèm nhãn ý, VD "a) Đ b) S c) S d) Đ".
- Ô bạn không chắc ≥ 95% đưa vào "uncertain" dạng "<mã đề>:P1.<câu>", "<mã đề>:P2.<câu><ý>", "<mã đề>:P3.<câu>".

CHỈ TRẢ VỀ JSON: {"keys":[{"ma_de":"101","p1":["A",...${n1} phần tử],"p2":[["Đ","S","Đ","S"],...${n2} mảng],"p3":["-1,5",...${n3} phần tử],"p1_raw":"1A 2B ...","p2_raw":["a) Đ b) S c) Đ d) S",...]}],"uncertain":[],"ghi_chu":""}`
}

async function geminiRequest(model: string, apiKey: string, system: string, image: string, highRes: boolean, extraText = '') {
  const generationConfig: Record<string, unknown> = { temperature: 0, responseMimeType: 'application/json' }
  // Độ phân giải ảnh cao giúp đọc ô chữ viết tay nhỏ (model cũ không hỗ trợ -> gọi lại không có tham số)
  if (highRes) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_HIGH'
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: image } },
            { text: extraText ? `LỚP CHỮ CỦA TRANG:\n${extraText}\n\nĐọc theo hướng dẫn và trả JSON.` : 'Đọc ảnh theo hướng dẫn và trả JSON.' },
          ],
        },
      ],
      generationConfig,
    }),
  })
  const data = await r.json().catch(() => null)
  return { r, data }
}

async function callGemini(model: string, apiKey: string, system: string, image: string, extraText = ''): Promise<AiAttempt> {
  let { r, data } = await geminiRequest(model, apiKey, system, image, true, extraText)
  if (r.status === 400) ({ r, data } = await geminiRequest(model, apiKey, system, image, false, extraText))
  if (!r.ok) return { ok: false, status: r.status, error: data?.error?.message || `HTTP ${r.status}` }
  return extractGemini(data)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractGemini(data: any): AiAttempt {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = data?.candidates?.[0]?.content?.parts || []
  const text = out
    .filter((x) => !x.thought)
    .map((x) => x.text || '')
    .join('')
  return text ? { ok: true, text } : { ok: false, status: 502, error: 'Gemini không trả về nội dung.' }
}

async function callClaude(model: string, apiKey: string, system: string, image: string, extraText = ''): Promise<AiAttempt> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      temperature: 0,
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            {
              type: 'text',
              text: `${extraText ? `LỚP CHỮ CỦA TRANG:\n${extraText}\n\n` : ''}Đọc theo hướng dẫn. Chỉ trả về JSON, không giải thích, không markdown.`,
            },
          ],
        },
      ],
    }),
  })
  const data = await r.json().catch(() => null)
  if (!r.ok) return { ok: false, status: r.status, error: data?.error?.message || `HTTP ${r.status}` }
  const text = (data?.content ?? [])
    .map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text : ''))
    .join('')
  return text ? { ok: true, text } : { ok: false, status: 502, error: 'Claude không trả về nội dung.' }
}

function shouldFallback(a: AiAttempt): boolean {
  return a.status === 429 || a.status === 404 || (a.status !== undefined && a.status >= 500) || /quota|not found|overloaded/i.test(a.error || '')
}

/** Bóc JSON từ câu trả lời (phòng khi AI bọc trong ```json ... ```) */
function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(t)
  } catch {
    const s = t.indexOf('{')
    const e = t.lastIndexOf('}')
    if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1))
    throw new Error('AI trả về không đúng định dạng JSON.')
  }
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Chỉ hỗ trợ POST.' })

  const auth = req.headers['authorization']
  const who = await verifyTeacher(Array.isArray(auth) ? auth[0] : auth)
  if (who === 'config') return res.status(500).json({ error: 'Máy chủ chưa cấu hình VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY trên Vercel.' })
  if (who === 'login') return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.' })
  if (who === 'pending') return res.status(403).json({ error: 'Tài khoản chưa được quản trị viên duyệt.' })

  let body
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).json({ error: 'Yêu cầu không hợp lệ.' })
  }
  const image = typeof body?.image === 'string' ? body.image : ''
  if (image.length < 1000) return res.status(400).json({ error: 'Thiếu ảnh phiếu.' })
  const n1 = clampInt(body?.n1, 12, 0, 50)
  const n2 = clampInt(body?.n2, 4, 0, 10)
  const n3 = clampInt(body?.n3, 6, 0, 20)
  const offset = clampInt(body?.modelOffset, 0, 0, 10)
  // mode: 'key' | 'sheet' (phiếu viết tay kiểu cũ), 'fields' (phiếu tô ô: chỉ đọc chữ viết tay), 'keytable' (bảng đáp án)
  const m = String(body?.mode || 'sheet')
  const pageText = m === 'keytable' && typeof body?.text === 'string' ? body.text.slice(0, 20000) : ''
  const system =
    m === 'fields'
      ? fieldsPrompt(body?.kind === 'class' ? 'class' : 'school', n3)
      : m === 'keytable'
        ? keyTablePrompt(n1, n2, n3, !!pageText.trim())
        : systemPrompt(n1, n2, n3, m === 'key' ? 'key' : 'sheet')

  const geminiKey = env.GEMINI_API_KEY
  const claudeKey = env.ANTHROPIC_API_KEY
  if (!geminiKey && !claudeKey)
    return res.status(500).json({ error: 'Máy chủ chưa cấu hình GEMINI_API_KEY hoặc ANTHROPIC_API_KEY trên Vercel.' })

  const log: string[] = []
  let quotaHit = false

  if (geminiKey) {
    const list = (env.OMR_MODELS || env.GEMINI_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean)
    const base = list.length ? list : DEFAULT_GEMINI_MODELS
    // Xoay vòng danh sách theo offset: lần đọc đối chiếu dùng model khác lần đọc chính
    const models = base.slice(offset % base.length).concat(base.slice(0, offset % base.length))
    for (const model of models) {
      const a = await callGemini(model, geminiKey, system, image, pageText)
      if (a.ok) {
        try {
          return res.status(200).json({ data: parseJson(a.text || ''), provider: 'gemini', model })
        } catch (e) {
          log.push(`${model}: ${(e as Error).message}`)
          continue
        }
      }
      if (a.status === 429) quotaHit = true
      log.push(`${model}: ${a.status} ${(a.error || '').slice(0, 120)}`)
      if (!shouldFallback(a)) break
    }
  }

  if (claudeKey) {
    const model = env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL
    const a = await callClaude(model, claudeKey, system, image, pageText)
    if (a.ok) {
      try {
        return res.status(200).json({ data: parseJson(a.text || ''), provider: 'claude', model })
      } catch (e) {
        log.push(`${model}: ${(e as Error).message}`)
      }
    } else log.push(`${model}: ${a.status} ${(a.error || '').slice(0, 120)}`)
  }

  const msg = quotaHit
    ? 'Đã hết lượt AI miễn phí trong ngày (Gemini). Hạn mức tự làm mới lúc khoảng 14–15 giờ chiều (giờ Việt Nam).'
    : 'Không đọc được phiếu bằng AI.'
  return res.status(502).json({ error: `${msg}\nChi tiết: ${log.join(' | ')}` })
}
