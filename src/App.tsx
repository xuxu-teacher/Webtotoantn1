import { useEffect, useState } from 'react';
import FileUpload from './components/FileUpload';
import DisabilityAccommodationForm from './components/DisabilityAccommodationForm';
import LessonPlanForm from './components/LessonPlanForm';
import LessonPlanPreview from './components/LessonPlanPreview';
import { generateLessonPlan } from './utils/aiClient';
import { exportLessonPlanToDocx } from './utils/exportDocx';
import type { DisabilityAccommodation, ParsedDocument } from './types';

export default function App() {
  const [parsedDoc, setParsedDoc] = useState<ParsedDocument | null>(null);
  const [subject, setSubject] = useState('');
  const [grade, setGrade] = useState('');
  const [lessonTitle, setLessonTitle] = useState('');
  const [durationPeriods, setDurationPeriods] = useState(1);
  const [extraRequirements, setExtraRequirements] = useState('');
  const [accommodation, setAccommodation] = useState<DisabilityAccommodation>({ types: [], notes: '' });

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ markdown: string; warnings: string[] } | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setApiKeyConfigured(Boolean(d.hasApiKey)))
      .catch(() => setApiKeyConfigured(null)); // không xác định được (ví dụ đang chạy vite thuần) -> không cảnh báo
  }, []);

  async function handleGenerate() {
    if (!lessonTitle.trim() || !subject.trim()) {
      setGenError('Vui lòng nhập Môn học và Tên bài học trước khi soạn.');
      return;
    }
    setGenError(null);
    setGenerating(true);
    setResult(null);
    try {
      const sourceContent = parsedDoc ? parsedDoc.sourceTextWithPlaceholders : '';
      const res = await generateLessonPlan({
        subject,
        grade,
        lessonTitle,
        durationPeriods,
        sourceContent,
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
  const noPreviewCount = equationEntries.filter((e) => !e.convertible && !e.previewImage).length;

  return (
    <div className="page">
      {apiKeyConfigured === false && (
        <div className="config-banner">
          ⚠️ Server chưa cấu hình <code>ANTHROPIC_API_KEY</code> — nút "Soạn KHBD bằng AI" sẽ báo lỗi.
          Khai báo biến này trong <strong>Vercel → Project Settings → Environment Variables</strong> rồi
          deploy lại (xem chi tiết trong README.md).
        </div>
      )}

      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__mark">KHBD</span>
          <div>
            <h1>Kế hoạch bài dạy — Năng lực số &amp; AI</h1>
            <p>Đẩy giáo án Word gốc, AI soạn lại theo khung hiện hành, có cột riêng năng lực số &amp; giáo dục hòa nhập.</p>
          </div>
        </div>
      </header>

      <LessonPlanForm
        subject={subject}
        grade={grade}
        lessonTitle={lessonTitle}
        durationPeriods={durationPeriods}
        extraRequirements={extraRequirements}
        onChange={(patch) => {
          if (patch.subject !== undefined) setSubject(patch.subject);
          if (patch.grade !== undefined) setGrade(patch.grade);
          if (patch.lessonTitle !== undefined) setLessonTitle(patch.lessonTitle);
          if (patch.durationPeriods !== undefined) setDurationPeriods(patch.durationPeriods);
          if (patch.extraRequirements !== undefined) setExtraRequirements(patch.extraRequirements);
        }}
      />

      <main className="page__grid">
        <section className="page__col">
          <h2 className="section-title">1. Giáo án gốc</h2>
          <FileUpload onParsed={setParsedDoc} />
          {parsedDoc && (
            <div className="parse-summary">
              <p>
                Đã đọc <strong>{parsedDoc.fileName}</strong> — {parsedDoc.equationCount} công thức nhận diện được.
              </p>
              {rasterPreviewCount > 0 && (
                <p className="parse-summary__ok">✓ {rasterPreviewCount} công thức MathType hiển thị được bằng ảnh xem trước.</p>
              )}
              {legacyImageCount > 0 && (
                <p className="parse-summary__warning">
                  ⚠️ {legacyImageCount} công thức có ảnh gốc định dạng WMF/EMF — trình duyệt không hiển thị trực
                  tiếp được (giới hạn chung của web), app cho tải ảnh gốc về ở bản xem trước.
                </p>
              )}
              {noPreviewCount > 0 && (
                <p className="parse-summary__warning">
                  ⚠️ {noPreviewCount} công thức không tìm thấy dữ liệu lẫn ảnh xem trước trong file gốc.
                </p>
              )}
            </div>
          )}

          <h2 className="section-title">2. Học sinh khuyết tật (HSKT)</h2>
          <DisabilityAccommodationForm value={accommodation} onChange={setAccommodation} />

          {genError && <p className="error-banner">{genError}</p>}
          <button className="btn btn--primary" onClick={handleGenerate} disabled={generating}>
            {generating ? 'Đang soạn KHBD…' : 'Soạn KHBD bằng AI'}
          </button>
        </section>

        <section className="page__col page__col--preview">
          <h2 className="section-title">3. Kết quả</h2>
          {!result && !generating && <p className="empty-state">Kết quả sẽ hiện ở đây sau khi soạn.</p>}
          {generating && <p className="empty-state">AI đang soạn kế hoạch bài dạy…</p>}
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
                <LessonPlanPreview markdown={result.markdown} equations={parsedDoc?.equations || {}} />
              </div>
              <button
                className="btn btn--secondary"
                onClick={() => exportLessonPlanToDocx(result.markdown, parsedDoc?.equations || {}, `KHBD_${lessonTitle || 'bai-day'}`)}
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
