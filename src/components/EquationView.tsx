import MathRenderer from './MathRenderer';
import type { EquationEntry } from '../types';

interface Props {
  entry: EquationEntry | undefined;
  id: string;
}

/**
 * Trình duyệt không có khả năng giải mã WMF/EMF (định dạng ảnh Windows Metafile
 * cũ) — đây là giới hạn của nền tảng web nói chung, không riêng gì app này. Với
 * trường hợp đó, thay vì bỏ trắng, ta cho tải ảnh gốc về để giáo viên xem bằng
 * Word/Paint hoặc chèn tay lại.
 */
export default function EquationView({ entry, id }: Props) {
  if (!entry) {
    return <span className="math math--missing">[công thức #{id}]</span>;
  }

  if (entry.convertible && entry.mathml) {
    return <MathRenderer mathml={entry.mathml} />;
  }

  if (entry.latexFromExternalConverter) {
    return <MathRenderer latex={entry.latexFromExternalConverter} />;
  }

  if (entry.previewImage?.kind === 'raster') {
    return (
      <img
        className="math-preview-img"
        src={entry.previewImage.dataUrl}
        alt={`Công thức ${id} (MathType)`}
      />
    );
  }

  if (entry.previewImage?.kind === 'vector_legacy') {
    const ext = entry.previewImage.mime.split('/')[1] || 'wmf';
    return (
      <a
        className="math-preview-fallback"
        href={entry.previewImage.dataUrl}
        download={`cong-thuc-${id}.${ext}`}
        title="Trình duyệt không hiển thị được định dạng ảnh này — bấm để tải ảnh gốc"
      >
        📎 Công thức #{id} (.{ext} — bấm tải ảnh gốc)
      </a>
    );
  }

  return (
    <span className="math math--missing" title="Không tìm thấy dữ liệu hoặc ảnh của công thức này trong file gốc">
      [công thức #{id} — không trích được, xem file gốc]
    </span>
  );
}
