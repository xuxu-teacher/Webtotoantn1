import { GRADE_OPTIONS } from '../types';

interface Props {
  grade: string;
  lessonTitle: string;
  weekNumber: string;
  durationPeriods: number;
  extraRequirements: string;
  onChange: (patch: Partial<{ grade: string; lessonTitle: string; weekNumber: string; durationPeriods: number; extraRequirements: string }>) => void;
}

/**
 * Thanh công cụ nhập thông tin bài dạy — đặt cố định ở đầu trang, giáo viên
 * điền trước khi soạn. Môn học cố định là "Toán" (app này chỉ phục vụ Tổ Toán)
 * nên không cần ô nhập — hiển thị dạng nhãn tĩnh cho gọn.
 */
export default function LessonPlanForm({ grade, lessonTitle, weekNumber, durationPeriods, extraRequirements, onChange }: Props) {
  return (
    <div className="toolbar">
      <div className="toolbar__row">
        <label className="field field--grow-2">
          <span className="field__label">Tên bài học</span>
          <input value={lessonTitle} onChange={(e) => onChange({ lessonTitle: e.target.value })} placeholder="Ví dụ: Tính đơn điệu và cực trị của hàm số" />
        </label>
        <div className="field field--narrow">
          <span className="field__label">Môn học</span>
          <div className="field__static">Toán</div>
        </div>
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
          <span className="field__label">Tuần thực hiện</span>
          <input
            value={weekNumber}
            onChange={(e) => onChange({ weekNumber: e.target.value })}
            placeholder="Vd: 3"
          />
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
