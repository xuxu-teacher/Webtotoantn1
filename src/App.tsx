import { useEffect, useState } from 'react';
import FileUpload from './components/FileUpload';
import DisabilityAccommodationForm from './components/DisabilityAccommodationForm';
import LessonPlanForm from './components/LessonPlanForm';
import LessonPlanPreview from './components/LessonPlanPreview';
import SchoolLogo from './components/SchoolLogo';
import { generateLessonPlan } from './utils/aiClient';
import { exportLessonPlanToDocx } from './utils/exportDocx';
import { buildAiSourceText } from './utils/aiSourceBuilder';
import { convertEquationsBatch } from './utils/mathTypeConverterClient';
import type { DisabilityAccommodation, ParsedDocument } from './types';

export default function App() {
  const [parsedDoc, setParsedDoc] = useState<ParsedDocument | null>(null);
  const SUBJECT = 'Toán'; // App chỉ phục vụ Tổ Toán -> cố định, không cần ô nhập
  const [grade, setGrade] = useState('');
  const [lessonTitle, setLessonTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false); // true khi GV đã tự gõ -> không auto-fill đè lên nữa
  const [weekNumber, setWeekNumber] = useState('');
  const [durationPeriods, setDurationPeriods] = useState(1);
  const [extraRequirements, setExtraRequirements] = useState('');
  const [accommodation, setAccommodation] = useState<DisabilityAccommodation>({ types: [], notes: '' });
  const [headerNote, setHeaderNote] = useState('');

  const [generating, setGenerating] = useState(false);
  const [generatingSeconds, setGeneratingSeconds] = useState(0);
  const [result, setResult] = useState<{ markdown: string; warnings: string[] } | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);

  const [converting, setConverting] = useState(false);
  const [convertStatus, setConvertStatus] = useState<string | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setApiKeyConfigured(Boolean(d.hasApiKey)))
      .catch(() => setApiKeyConfigured(null)); // không xác định được (ví dụ đang chạy vite thuần) -> không cảnh báo
  }, []);

  // Đếm giây trong lúc AI đang soạn — giáo án dài (chép nguyên văn + 2 cột bổ
  // sung) có thể mất 30-90 giây, đếm giây giúp GV biết hệ thống vẫn đang chạy
  // chứ không phải bị treo, thay vì chỉ nhìn một dòng chữ tĩnh không đổi.
  useEffect(() => {
    if (!generating) {
      setGeneratingSeconds(0);
      return;
    }
    const timer = window.setInterval(() => setGeneratingSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  async function handleParsed(doc: ParsedDocument) {
    setParsedDoc(doc);
    if (!titleTouched && doc.suggestedTitle) {
      setLessonTitle(doc.suggestedTitle);
    }
    // Tự động chuyển đổi công thức MathType (OLE) ngay sau khi đọc file — giáo
    // viên không cần bấm thêm nút nào nữa, giống trải nghiệm ở trang thi thử.
    await runConversion(doc);
  }

  async function runConversion(doc: ParsedDocument) {
    const targets = Object.values(doc.equations).filter(
      (e) => !e.convertible && !e.latexFromExternalConverter && e.oleObjectBase64
    );
    if (targets.length === 0) return;

    setConverting(true);
    setConvertStatus(null);
    await convertEquationsBatch(targets, (update) => setConvertStatus(update.message));
    // targets là tham chiếu tới các object trong parsedDoc.equations -> đã được mutate,
    // chỉ cần tạo bản sao mới của map để React nhận biết thay đổi và render lại.
    setParsedDoc((prev) => (prev ? { ...prev, equations: { ...prev.equations } } : prev));
    setConverting(false);
  }

  function handleRetryConversion() {
    if (parsedDoc) runConversion(parsedDoc);
  }

  async function handleGenerate() {
    if (!lessonTitle.trim()) {
      setGenError('Vui lòng nhập Tên bài học trước khi soạn.');
      return;
    }
    setGenError(null);
    setGenerating(true);
    setResult(null);
    try {
      const { bodyText, equationLegend } = parsedDoc
        ? buildAiSourceText(parsedDoc)
        : { bodyText: '', equationLegend: '' };
      const res = await generateLessonPlan({
        subject: SUBJECT,
        grade,
        lessonTitle,
        durationPeriods,
        sourceContent: bodyText,
        equationLegend,
        accommodation,
        extraRequirements,
      });
      setResult(res);
    } catch (err: any) {
      setGenError(err.message || String(err));
    } finally {
      setGenerating(false);
    }
  }

  const equationEntries = parsedDoc ? Object.values(parsedDoc.equations) : [];
  const rasterPreviewCount = equationEntries.filter((e) => e.previewImage?.kind === 'raster').length;
  const legacyImageCount = equationEntries.filter((e) => e.previewImage?.kind === 'vector_legacy').length;
  const noPreviewCount = equationEntries.filter((e) => !e.convertible && !e.previewImage && !e.oleObjectBase64).length;
  const convertedCount = equationEntries.filter((e) => e.latexFromExternalConverter).length;
  const pendingConvertCount = equationEntries.filter(
    (e) => !e.convertible && !e.latexFromExternalConverter && e.oleObjectBase64
  ).length;

  return (
    <div className="page">
      {apiKeyConfigured === false && !bannerDismissed && (
        <div className="config-banner">
          <span className="config-banner__icon" aria-hidden="true">ⓘ</span>
          <p className="config-banner__text">
            Server chưa cấu hình <code>GEMINI_API_KEY</code> — nút "Soạn giáo án bằng AI" sẽ báo lỗi.
            Khai báo biến này trong <strong>Vercel → Project Settings → Environment Variables</strong> rồi
            deploy lại (xem chi tiết trong README.md).
          </p>
          <button
            className="config-banner__close"
            onClick={() => setBannerDismissed(true)}
            aria-label="Đóng thông báo"
            title="Đóng"
          >
            ×
          </button>
        </div>
      )}

      <header className="topbar">
        <div className="topbar__brand">
          <SchoolLogo />
          <div>
            <h1>Kế hoạch bài dạy — Năng lực số &amp; AI</h1>
            <p>Đẩy giáo án Word gốc, AI soạn lại theo khung hiện hành, có cột riêng năng lực số &amp; giáo dục hòa nhập.</p>
          </div>
        </div>
      </header>

      <section className="card header-note-card">
        <label className="field">
          <span className="field__label">Header tài liệu (tự ghi — in ở đầu file Word xuất ra, ví dụ tên trường/tổ chuyên môn/GV soạn)</span>
          <textarea
            rows={3}
            value={headerNote}
            onChange={(e) => setHeaderNote(e.target.value)}
            placeholder={'TRƯỜNG THPT SỐ 1 TƯ NGHĨA — TỔ TOÁN\nGiáo viên soạn: ...\nNăm học: ...'}
          />
        </label>
      </section>

      <LessonPlanForm
        grade={grade}
        lessonTitle={lessonTitle}
        weekNumber={weekNumber}
        durationPeriods={durationPeriods}
        extraRequirements={extraRequirements}
        onChange={(patch) => {
          if (patch.grade !== undefined) setGrade(patch.grade);
          if (patch.lessonTitle !== undefined) {
            setLessonTitle(patch.lessonTitle);
            setTitleTouched(true);
          }
          if (patch.weekNumber !== undefined) setWeekNumber(patch.weekNumber);
          if (patch.durationPeriods !== undefined) setDurationPeriods(patch.durationPeriods);
          if (patch.extraRequirements !== undefined) setExtraRequirements(patch.extraRequirements);
        }}
      />

      <main className="page__grid">
        <section className="page__col">
          <h2 className="section-title">1. Giáo án gốc</h2>
          <FileUpload onParsed={handleParsed} />
          {parsedDoc && (
            <div className="parse-summary">
              <p>
                Đã đọc <strong>{parsedDoc.fileName}</strong> — {parsedDoc.equationCount} công thức nhận diện được.
              </p>
              {rasterPreviewCount > 0 && (
                <p className="parse-summary__ok">✓ {rasterPreviewCount} công thức hiển thị được bằng ảnh xem trước.</p>
              )}
              {convertedCount > 0 && (
                <p className="parse-summary__ok">✓ {convertedCount} công thức đã chuyển đổi sang LaTeX bằng máy chủ riêng.</p>
              )}
              {legacyImageCount > 0 && (
                <p className="parse-summary__warning">
                  ⚠️ {legacyImageCount} công thức có ảnh gốc WMF/EMF — trình duyệt không hiển thị trực tiếp được.
                </p>
              )}
              {noPreviewCount > 0 && (
                <p className="parse-summary__warning">
                  ⚠️ {noPreviewCount} công thức không tìm thấy dữ liệu lẫn ảnh xem trước trong file gốc.
                </p>
              )}
              {converting && (
                <div className="convert-box convert-box--busy">
                  <span className="spinner" aria-hidden="true" />
                  <p className="convert-box__status">{convertStatus || 'Đang tự động chuyển đổi công thức MathType…'}</p>
                </div>
              )}
              {!converting && pendingConvertCount > 0 && (
                <div className="convert-box">
                  <p className="convert-box__status convert-box__status--warning">
                    {convertStatus || `${pendingConvertCount} công thức chưa chuyển đổi được.`}
                  </p>
                  <button className="btn btn--convert" onClick={handleRetryConversion}>
                    🔄 Thử chuyển đổi lại
                  </button>
                </div>
              )}
            </div>
          )}

          <h2 className="section-title">2. Học sinh khuyết tật (HSKT)</h2>
          <DisabilityAccommodationForm value={accommodation} onChange={setAccommodation} />

          <h2 className="section-title">3. Soạn giáo án tích hợp năng lực số</h2>
          <p className="step-hint">
            AI sẽ soạn KHBD đầy đủ, có cột riêng năng lực số &amp; giáo dục hòa nhập, dựa trên thông tin và giáo án gốc ở trên.
          </p>
          {genError && <p className="error-banner">{genError}</p>}
          <button className="btn btn--primary" onClick={handleGenerate} disabled={generating}>
            {generating ? 'Đang soạn KHBD…' : 'Soạn giáo án bằng AI'}
          </button>
        </section>

        <section className="page__col page__col--preview">
          <h2 className="section-title">4. Kết quả</h2>
          {!result && !generating && <p className="empty-state">Kết quả sẽ hiện ở đây sau khi soạn.</p>}
          {generating && (
            <div className="generating-status">
              <span className="spinner" aria-hidden="true" />
              <div>
                <p className="generating-status__text">
                  AI đang soạn kế hoạch bài dạy… ({generatingSeconds}s)
                </p>
                <p className="generating-status__hint">
                  Giáo án càng dài (chép nguyên văn + thêm cột năng lực số/hòa nhập cho từng
                  mục) thì càng mất nhiều thời gian — thường 30–90 giây, đôi khi hơn với bài
                  rất dài. Đừng tắt trang trong lúc chờ.
                </p>
              </div>
            </div>
          )}
          {result && (
            <>
              {result.warnings.length > 0 && (
                <div className="warning-box">
                  {result.warnings.map((w, i) => (
                    <p key={i}>⚠️ {w}</p>
                  ))}
                </div>
              )}
              <div className="preview-panel">
                {(headerNote.trim() || weekNumber.trim()) && (
                  <div className="letterhead-preview">
                    {headerNote.split('\n').filter(Boolean).map((line, i) => (
                      <p key={i} className={i === 0 ? 'letterhead-preview__main' : ''}>
                        {line}
                      </p>
                    ))}
                    {weekNumber.trim() && <p>Tuần thực hiện: {weekNumber.trim()}</p>}
                  </div>
                )}
                <LessonPlanPreview markdown={result.markdown} equations={parsedDoc?.equations || {}} />
              </div>
              <button
                className="btn btn--secondary"
                onClick={() =>
                  exportLessonPlanToDocx(
                    result.markdown,
                    parsedDoc?.equations || {},
                    `KHBD_${lessonTitle || 'bai-day'}`,
                    headerNote,
                    weekNumber
                  )
                }
              >
                Tải về file Word (.docx)
              </button>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
