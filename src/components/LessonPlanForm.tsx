interface Props {
  subject: string;
  grade: string;
  lessonTitle: string;
  durationPeriods: number;
  extraRequirements: string;
  onChange: (patch: Partial<{ subject: string; grade: string; lessonTitle: string; durationPeriods: number; extraRequirements: string }>) => void;
}

export default function LessonPlanForm({ subject, grade, lessonTitle, durationPeriods, extraRequirements, onChange }: Props) {
  return (
    <div className="card">
      <div className="grid-2">
        <label className="field">
          <span className="field__label">Môn học</span>
          <input value={subject} onChange={(e) => onChange({ subject: e.target.value })} placeholder="Ví dụ: Toán" />
        </label>
        <label className="field">
          <span className="field__label">Khối lớp</span>
          <input value={grade} onChange={(e) => onChange({ grade: e.target.value })} placeholder="Ví dụ: Lớp 9" />
        </label>
      </div>
      <label className="field">
        <span className="field__label">Tên bài học</span>
        <input value={lessonTitle} onChange={(e) => onChange({ lessonTitle: e.target.value })} placeholder="Ví dụ: Phương trình bậc hai một ẩn" />
      </label>
      <label className="field field--narrow">
        <span className="field__label">Số tiết</span>
        <input
          type="number"
          min={1}
          value={durationPeriods}
          onChange={(e) => onChange({ durationPeriods: Number(e.target.value) || 1 })}
        />
      </label>
      <label className="field">
        <span className="field__label">Yêu cầu thêm cho AI (không bắt buộc)</span>
        <textarea
          rows={3}
          value={extraRequirements}
          onChange={(e) => onChange({ extraRequirements: e.target.value })}
          placeholder="Ví dụ: nhấn mạnh hoạt động nhóm, dùng thêm công cụ AI cụ thể nào đó…"
        />
      </label>
    </div>
  );
}
