import { DISABILITY_LABELS } from '../types';
import type { DisabilityAccommodation, DisabilityType } from '../types';

interface Props {
  value: DisabilityAccommodation;
  onChange: (value: DisabilityAccommodation) => void;
}

const ORDER: DisabilityType[] = ['nhin', 'nghe', 'van_dong', 'tri_tue', 'ngon_ngu', 'khac'];

export default function DisabilityAccommodationForm({ value, onChange }: Props) {
  function toggle(type: DisabilityType) {
    const has = value.types.includes(type);
    const types = has ? value.types.filter((t) => t !== type) : [...value.types, type];
    onChange({ ...value, types });
  }

  return (
    <fieldset className="card">
      <legend className="card__legend">Chọn loại khuyết tật của HSKT (nếu lớp có)</legend>
      <div className="checkbox-list">
        {ORDER.map((type) => (
          <label key={type} className="checkbox-row">
            <input
              type="checkbox"
              checked={value.types.includes(type)}
              onChange={() => toggle(type)}
            />
            <span>{DISABILITY_LABELS[type]}</span>
          </label>
        ))}
      </div>
      <label className="field">
        <span className="field__label">Ghi chú thêm về nhu cầu hỗ trợ cụ thể (không bắt buộc)</span>
        <textarea
          rows={3}
          value={value.notes}
          onChange={(e) => onChange({ ...value, notes: e.target.value })}
          placeholder="Ví dụ: 1 học sinh khiếm thị mức độ nhẹ, cần phóng to tài liệu cỡ chữ 20…"
        />
      </label>
    </fieldset>
  );
}
