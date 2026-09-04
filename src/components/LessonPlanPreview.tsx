import { Fragment } from 'react';
import EquationView from './EquationView';
import MathRenderer from './MathRenderer';
import { parseKhbd } from '../utils/khbdParser';
import { parseContentLines, trySectionMerge, type ContentLine } from '../utils/markdownTable';
import { parseLatexSafe } from '../utils/latexToMathNode';
import { mathNodeToMathml } from '../utils/mathToMathml';
import type { EquationEntry, ImageEntry } from '../types';

interface Props {
  markdown: string;
  equations: Record<string, EquationEntry>;
  images: Record<string, ImageEntry>;
  weekNumber?: string;
  durationPeriods?: number;
}

function renderInline(
  text: string,
  key: string,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>
) {
  const parts = text.split(/(\[\[EQ:[^\]]+\]\]|\[\[IMG:[^\]]+\]\]|\$[^$]+\$)/g).filter((p) => p !== '');
  return parts.map((part, i) => {
    const imgMatch = part.match(/^\[\[IMG:([^\]]+)\]\]$/);
    if (imgMatch) {
      const entry = images[imgMatch[1]];
      if (entry?.kind === 'raster') {
        return <img key={`${key}-${i}`} className="lesson-preview__image" src={entry.dataUrl} alt={`Hình vẽ ${imgMatch[1]}`} />;
      }
      return (
        <span key={`${key}-${i}`} className="math math--missing" title="Không trích được ảnh này từ file gốc">
          [hình vẽ #{imgMatch[1]} — không trích được, xem file gốc]
        </span>
      );
    }
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

function renderContentLines(
  items: ContentLine[],
  keyPrefix: string,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>
) {
  return items.map((item, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (item.type === 'bullet') {
      return <li key={key}>{renderInline(item.text, key, equations, images)}</li>;
    }
    if (item.type === 'table') {
      const [header, ...body] = item.rows;
      return (
        <table className="khbd-table" key={key}>
          <thead>
            <tr>
              {header.map((cell, ci) => (
                <th key={`${key}-h${ci}`}>{renderInline(cell, `${key}-h${ci}`, equations, images)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={`${key}-r${ri}`}>
                {row.map((cell, ci) => (
                  <td key={`${key}-r${ri}c${ci}`}>{renderInline(cell, `${key}-r${ri}c${ci}`, equations, images)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return <p key={key}>{renderInline(item.text, key, equations, images)}</p>;
  });
}

function renderMultiline(
  text: string,
  keyPrefix: string,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>
) {
  return renderContentLines(parseContentLines(text), keyPrefix, equations, images);
}

/**
 * Bảng đã GỘP thêm cột Năng lực số/Hòa nhập trực tiếp vào bảng gốc (thay vì để
 * cạnh thành cột riêng) — dùng khi khối GOC của mục đó vốn đã là một bảng thật.
 * Nội dung SO/KT hiện dạng MỘT Ô gộp dọc (rowSpan) suốt chiều cao bảng, vì đó
 * là một đoạn văn chung cho cả mục chứ không tách theo từng dòng bảng gốc.
 */
function renderMergedTable(
  merged: NonNullable<ReturnType<typeof trySectionMerge>>,
  keyPrefix: string,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>
) {
  const { headers, rows, soText, ktText } = merged;
  return (
    <table className="khbd-table khbd-table--merged" key={`${keyPrefix}-merged`}>
      <thead>
        <tr>
          {headers.map((h, ci) => (
            <th key={`${keyPrefix}-h${ci}`}>{renderInline(h, `${keyPrefix}-h${ci}`, equations, images)}</th>
          ))}
          {soText !== null && <th className="khbd-table__so-th">Năng lực số</th>}
          {ktText !== null && <th className="khbd-table__kt-th">Giáo dục hòa nhập (HSKT)</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={`${keyPrefix}-r${ri}`}>
            {row.map((cell, ci) => (
              <td key={`${keyPrefix}-r${ri}c${ci}`}>{renderInline(cell, `${keyPrefix}-r${ri}c${ci}`, equations, images)}</td>
            ))}
            {soText !== null && ri === 0 && (
              <td className="khbd-table__so-td" rowSpan={rows.length}>
                {renderMultiline(soText, `${keyPrefix}-so`, equations, images)}
              </td>
            )}
            {ktText !== null && ri === 0 && (
              <td className="khbd-table__kt-td" rowSpan={rows.length}>
                {renderMultiline(ktText, `${keyPrefix}-kt`, equations, images)}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function LessonPlanPreview({ markdown, equations, images, weekNumber, durationPeriods }: Props) {
  const blocks = parseKhbd(markdown);
  const firstHeadingIdx = blocks.findIndex((b) => b.type === 'heading');
  const subtitleParts = [
    weekNumber?.trim() ? `Tuần thực hiện: ${weekNumber.trim()}` : '',
    durationPeriods ? `Số tiết: ${durationPeriods}` : '',
  ].filter(Boolean);

  return (
    <div className="lesson-preview">
      {blocks.map((block, idx) => {
        if (block.type === 'heading') {
          const Tag = (`h${block.level}` as unknown) as 'h1' | 'h2' | 'h3';
          return (
            <Fragment key={idx}>
              <Tag>{block.text}</Tag>
              {idx === firstHeadingIdx && subtitleParts.length > 0 && (
                <p className="lesson-preview__subtitle">{subtitleParts.join('  —  ')}</p>
              )}
            </Fragment>
          );
        }
        if (block.type === 'text') {
          return <p key={idx}>{renderInline(block.text, String(idx), equations, images)}</p>;
        }

        const hasSo = block.so.trim().length > 0;
        const hasKt = block.kt.trim().length > 0;
        const merged = trySectionMerge(block.goc, block.so, block.kt);

        if (merged) {
          return (
            <div className="khbd-merged" key={idx}>
              {merged.beforeTable.length > 0 && renderContentLines(merged.beforeTable, `${idx}-before`, equations, images)}
              {renderMergedTable(merged, `${idx}`, equations, images)}
            </div>
          );
        }

        const colCount = 1 + (hasSo ? 1 : 0) + (hasKt ? 1 : 0);

        return (
          <div className={`khbd-row khbd-row--cols-${colCount}`} key={idx}>
            <div className="khbd-col khbd-col--goc">
              {renderMultiline(block.goc, `${idx}-goc`, equations, images)}
            </div>
            {hasSo && (
              <div className="khbd-col khbd-col--so">
                <p className="khbd-col__label khbd-col__label--so">Năng lực số</p>
                {renderMultiline(block.so, `${idx}-so`, equations, images)}
              </div>
            )}
            {hasKt && (
              <div className="khbd-col khbd-col--kt">
                <p className="khbd-col__label khbd-col__label--kt">Giáo dục hòa nhập (HSKT)</p>
                {renderMultiline(block.kt, `${idx}-kt`, equations, images)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
