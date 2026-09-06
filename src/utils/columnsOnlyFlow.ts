import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { findActivityTables, injectAllColumns, type ColumnContent } from './docxColumnInjector';
import type { DisabilityAccommodation } from '../types';

export interface ColumnsOnlyOptions {
  subject: string;
  grade: string;
  accommodation: DisabilityAccommodation;
}

export interface ColumnsOnlyResult {
  tablesFound: number;
  tablesUpdated: number;
  alreadyHadNls: number;
  alreadyHadKt: number;
}

/**
 * Chế độ "chỉ thêm cột" — KHÔNG đi qua bước trích xuất-rồi-AI-viết-lại-toàn-bộ
 * (cách làm ở exportLessonPlanToDocx/generateLessonPlanSmart), nên tránh được
 * hẳn các lỗi đã gặp khi AI phải chép lại nguyên văn nội dung dài/phức tạp
 * (bảng bị làm phẳng, marker rò rỉ, bảng biến thiên sai số liệu...). Thay vào
 * đó: đọc thẳng XML gốc, tìm các bảng hoạt động, chỉ nhờ AI viết vài câu ngắn
 * cho cột Năng lực số/Giáo dục hòa nhập, rồi CHÈN TRỰC TIẾP vào XML gốc —
 * toàn bộ nội dung/công thức/hình vẽ/định dạng còn lại giữ nguyên 100%.
 */
export async function runColumnsOnlyFlow(file: File, options: ColumnsOnlyOptions): Promise<ColumnsOnlyResult> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) throw new Error('File .docx không hợp lệ — không tìm thấy word/document.xml.');
  const documentXml = await docXmlFile.async('text');

  const tables = findActivityTables(documentXml);
  if (tables.length === 0) {
    throw new Error(
      'Không tìm thấy bảng "HOẠT ĐỘNG CỦA GV VÀ HS | SẢN PHẨM DỰ KIẾN" nào trong file — chế độ này chỉ hoạt động với giáo án đã có sẵn dạng bảng đó.'
    );
  }

  const hasHsKt = Boolean(options.accommodation.types.length || options.accommodation.notes.trim());

  const needy = tables
    .map((t, index) => ({ index, table: t, needNls: !t.hasNls, needKt: hasHsKt && !t.hasKt }))
    .filter((t) => t.needNls || t.needKt);

  const alreadyHadNls = tables.filter((t) => t.hasNls).length;
  const alreadyHadKt = tables.filter((t) => t.hasKt).length;

  if (needy.length === 0) {
    // Không có gì cần thêm (mọi bảng đã có đủ cột) -> vẫn xuất lại file y
    // nguyên để giáo viên có phản hồi rõ ràng thay vì im lặng không làm gì.
    saveAs(await zip.generateAsync({ type: 'blob' }), file.name.replace(/\.docx$/i, '') + ' (đã có đủ cột).docx');
    return { tablesFound: tables.length, tablesUpdated: 0, alreadyHadNls, alreadyHadKt };
  }

  const response = await fetch('/api/generate-columns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: options.subject,
      grade: options.grade,
      accommodation: options.accommodation,
      tables: needy.map((t) => ({
        index: t.index,
        heading: t.table.heading,
        gvHsText: t.table.gvHsText,
        sanPhamText: t.table.sanPhamText,
        needNls: t.needNls,
        needKt: t.needKt,
      })),
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: `Lỗi HTTP ${response.status}` }));
    throw new Error(err.error || `Lỗi HTTP ${response.status}`);
  }

  const { results } = (await response.json()) as {
    results: { index: number; nls?: string; kt?: string }[];
  };

  const contentByIndex = new Map<number, ColumnContent>();
  for (const r of results) {
    const need = needy.find((n) => n.index === r.index);
    if (!need) continue;
    const content: ColumnContent = {};
    if (need.needNls && r.nls) content.nls = r.nls;
    if (need.needKt && r.kt) content.kt = r.kt;
    if (content.nls !== undefined || content.kt !== undefined) contentByIndex.set(r.index, content);
  }

  if (contentByIndex.size === 0) {
    throw new Error('AI không trả về nội dung hợp lệ cho bất kỳ bảng nào — thử lại.');
  }

  const newDocumentXml = injectAllColumns(documentXml, tables, contentByIndex);
  zip.file('word/document.xml', newDocumentXml);
  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, file.name.replace(/\.docx$/i, '') + ' (đã thêm cột).docx');

  return { tablesFound: tables.length, tablesUpdated: contentByIndex.size, alreadyHadNls, alreadyHadKt };
}
