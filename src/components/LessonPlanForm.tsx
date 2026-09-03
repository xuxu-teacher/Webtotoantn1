import { GRADE_OPTIONS } from '../types';

interface Props {
  subject: string;
  grade: string;
  lessonTitle: string;
  durationPeriods: number;
  extraRequirements: string;
  onChange: (patch: Partial<{ subject: string; grade: string; lessonTitle: string; durationPeriods: number; extraRequirements: string }>) => void;
}

/** Thanh công cụ nhập thông tin bài dạy — đặt cố định ở đầu trang, giáo viên điền trước khi soạn. */
export default function LessonPlanForm({ subject, grade, lessonTitle, durationPeriods, extraRequirements, onChange }: Props) {
  return (
    <div className="toolbar">
      <div className="toolbar__row">
        <label className="field field--grow-2">
          <span className="field__label">Tên bài học</span>
          <input value={lessonTitle} onChange={(e) => onChange({ lessonTitle: e.target.value })} placeholder="Ví dụ: Tính đơn điệu và cực trị của hàm số" />
        </label>
        <label className="field">
          <span className="field__label">Môn học</span>
          <input value={subject} onChange={(e) => onChange({ subject: e.target.value })} placeholder="Ví dụ: Toán" />
        </label>
        <label className="field field--narrow">
          <span className="field__label">Khối lớp</span>
          <select value={grade} onChange={(e) => onChange({ grade: e.target.value })}>
            <option value="">— Chọn lớp —</option>
            {GRADE_OPTIONS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--tiny">
          <span className="field__label">Số tiết</span>
          <input
            type="number"
            min={1}
            value={durationPeriods}
            onChange={(e) => onChange({ durationPeriods: Number(e.target.value) || 1 })}
          />
        </label>
      </div>
      <label className="field">
        <span className="field__label">Yêu cầu thêm cho AI (không bắt buộc)</span>
        <textarea
          rows={2}
          value={extraRequirements}
          onChange={(e) => onChange({ extraRequirements: e.target.value })}
          placeholder="Ví dụ: nhấn mạnh hoạt động nhóm, dùng thêm công cụ AI cụ thể nào đó…"
        />
      </label>
    </div>
  );
}
