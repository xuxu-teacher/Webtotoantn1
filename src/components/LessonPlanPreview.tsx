import EquationView from './EquationView';
import MathRenderer from './MathRenderer';
import { parseKhbd } from '../utils/khbdParser';
import { parseLatexSafe } from '../utils/latexToMathNode';
import { mathNodeToMathml } from '../utils/mathToMathml';
import type { EquationEntry } from '../types';

interface Props {
  markdown: string;
  equations: Record<string, EquationEntry>;
}

function renderInline(text: string, key: string, equations: Record<string, EquationEntry>) {
  const parts = text.split(/(\[\[EQ:[^\]]+\]\]|\$[^$]+\$)/g).filter((p) => p !== '');
  return parts.map((part, i) => {
    const eqMatch = part.match(/^\[\[EQ:([^\]]+)\]\]$/);
    if (eqMatch) {
      return <EquationView key={`${key}-${i}`} entry={equations[eqMatch[1]]} id={eqMatch[1]} />;
    }
    if (part.startsWith('$') && part.endsWith('$')) {
      // Công thức AI viết thêm (không có trong file gốc) -> phân tích LaTeX
      // thành MathNode rồi render bằng chính pipeline MathML dùng cho công
      // thức gốc, để không hiện chữ LaTeX thô ("\left(", "^{...}") ra bài.
      const mathml = mathNodeToMathml(parseLatexSafe(part.slice(1, -1)));
      return <MathRenderer key={`${key}-${i}`} mathml={mathml} />;
    }
    return <span key={`${key}-${i}`}>{part}</span>;
  });
}

function renderMultiline(text: string, keyPrefix: string, equations: Record<string, EquationEntry>) {
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.map((line, idx) => {
    const trimmed = line.trim();
    const key = `${keyPrefix}-${idx}`;
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      return <li key={key}>{renderInline(trimmed.slice(2), key, equations)}</li>;
    }
    return <p key={key}>{renderInline(trimmed, key, equations)}</p>;
  });
}

export default function LessonPlanPreview({ markdown, equations }: Props) {
  const blocks = parseKhbd(markdown);

  return (
    <div className="lesson-preview">
      {blocks.map((block, idx) => {
        if (block.type === 'heading') {
          const Tag = (`h${block.level}` as unknown) as 'h1' | 'h2' | 'h3';
          return <Tag key={idx}>{block.text}</Tag>;
        }
        if (block.type === 'text') {
          return <p key={idx}>{renderInline(block.text, String(idx), equations)}</p>;
        }

        const hasSo = block.so.trim().length > 0;
        const hasKt = block.kt.trim().length > 0;
        const colCount = 1 + (hasSo ? 1 : 0) + (hasKt ? 1 : 0);

        return (
          <div className={`khbd-row khbd-row--cols-${colCount}`} key={idx}>
            <div className="khbd-col khbd-col--goc">
              {renderMultiline(block.goc, `${idx}-goc`, equations)}
            </div>
            {hasSo && (
              <div className="khbd-col khbd-col--so">
                <p className="khbd-col__label khbd-col__label--so">Năng lực số</p>
                {renderMultiline(block.so, `${idx}-so`, equations)}
              </div>
            )}
            {hasKt && (
              <div className="khbd-col khbd-col--kt">
                <p className="khbd-col__label khbd-col__label--kt">Giáo dục hòa nhập (HSKT)</p>
                {renderMultiline(block.kt, `${idx}-kt`, equations)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
