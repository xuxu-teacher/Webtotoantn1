import { useRef, useState } from 'react';
import type { ParsedDocument } from '../types';
import { parseDocxFile } from '../utils/docxParser';

interface Props {
  onParsed: (doc: ParsedDocument) => void;
}

export default function FileUpload({ onParsed }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.docx')) {
      setError('Chỉ hỗ trợ file .docx (Word). File .doc cũ cần lưu lại dưới dạng .docx trước.');
      return;
    }
    setError(null);
    setLoading(true);
    setFileName(file.name);
    try {
      const parsed = await parseDocxFile(file);
      onParsed(parsed);
    } catch (err: any) {
      setError(`Không đọc được file: ${err.message || String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className={`upload-zone ${dragOver ? 'upload-zone--active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".docx"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      <span className="upload-zone__icon">📄</span>
      <p className="upload-zone__title">
        {fileName ? fileName : 'Kéo thả hoặc bấm để chọn giáo án (.docx)'}
      </p>
      <p className="upload-zone__hint">
        Tự nhận diện công thức Word (Insert Equation) và công thức MathType kiểu OLE cũ — công thức
        MathType sẽ được tự động chuyển đổi ngay sau khi đọc file, không cần thao tác gì thêm.
      </p>
      {loading && <p className="upload-zone__status">Đang đọc file…</p>}
      {error && <p className="upload-zone__error">{error}</p>}
    </div>
  );
}
