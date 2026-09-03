import MathRenderer from './MathRenderer';
import { parseKhbd } from '../utils/khbdParser';
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
      const entry = equations[eqMatch[1]];
      if (entry?.convertible && entry.mathml) {
        return <MathRenderer key={`${key}-${i}`} mathml={entry.mathml} />;
      }
      return (
        <span key={`${key}-${i}`} className="math math--missing" title="Công thức MathType cũ, không trích được — xem file gốc">
          [công thức #{eqMatch[1]}]
        </span>
      );
    }
    if (part.startsWith('$') && part.endsWith('$')) {
      return <MathRenderer key={`${key}-${i}`} latex={part.slice(1, -1)} />;
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
        return (
          <div className="khbd-row" key={idx}>
            <div className="khbd-col khbd-col--left">{renderMultiline(block.left, `${idx}-l`, equations)}</div>
            <div className="khbd-col khbd-col--right">
              <p className="khbd-col__label">Năng lực số &amp; Giáo dục hòa nhập</p>
              {renderMultiline(block.right, `${idx}-r`, equations)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
