import { Fragment } from 'react';
import EquationView from './EquationView';
import MathRenderer from './MathRenderer';
import { parseKhbd } from '../utils/khbdParser';
import { parseContentLines, trySectionMerge, type ContentLine } from '../utils/markdownTable';
import { parseLatexSafe } from '../utils/latexToMathNode';
import { mathNodeToMathml } from '../utils/mathToMathml';
import type { EquationEntry, ImageEntry, TableEntry } from '../types';

interface Props {
  markdown: string;
  equations: Record<string, EquationEntry>;
  images: Record<string, ImageEntry>;
  tables: Record<string, TableEntry>;
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

/**
 * Tách một dòng theo placeholder bảng LỒNG "[[TBL:xxx]]" (gắn từ docxParser.ts
 * khi một ô của bảng gốc — ví dụ "SẢN PHẨM DỰ KIẾN" — chứa một bảng khác bên
 * trong, như bảng biến thiên). Phần chữ thường đi qua renderInline như cũ;
 * phần placeholder dựng thành MỘT BẢNG THẬT lồng bên trong, thay vì hiện
 * nguyên văn "[[TBL:...]]" hay để lộ cú pháp bảng bị escape hỏng ("\| ... \|").
 */
function renderLineParts(
  text: string,
  keyPrefix: string,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>,
  tables: Record<string, TableEntry>
) {
  const segments = text.split(/(\[\[TBL:[^\]]+\]\])/g).filter((s) => s !== '');
  return segments.map((seg, i) => {
    const tblMatch = seg.match(/^\[\[TBL:([^\]]+)\]\]$/);
    if (tblMatch) {
      const entry = tables[tblMatch[1]];
      if (entry && entry.rows.length > 0) {
        return renderNestedTable(entry.rows, `${keyPrefix}-tbl${i}`, equations, images, tables);
      }
      return (
        <span key={`${keyPrefix}-tbl${i}`} className="math math--missing" title="Không trích được bảng này từ file gốc">
          [bảng #{tblMatch[1]} — không trích được, xem file gốc]
        </span>
      );
    }
    return <Fragment key={`${keyPrefix}-t${i}`}>{renderInline(seg, `${keyPrefix}-t${i}`, equations, images)}</Fragment>;
  });
}

function renderNestedTable(
  rows: string[][],
  keyPrefix: string,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>,
  tables: Record<string, TableEntry>
) {
  const [header, ...body] = rows;
  return (
    <table className="khbd-table khbd-table--nested" key={keyPrefix}>
      <thead>
        <tr>
          {header.map((cell, ci) => (
            <th key={`${keyPrefix}-h${ci}`}>{renderLineParts(cell, `${keyPrefix}-h${ci}`, equations, images, tables)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, ri) => (
          <tr key={`${keyPrefix}-r${ri}`}>
            {row.map((cell, ci) => (
              <td key={`${keyPrefix}-r${ri}c${ci}`}>{renderLineParts(cell, `${keyPrefix}-r${ri}c${ci}`, equations, images, tables)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderContentLines(
  items: ContentLine[],
  keyPrefix: string,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>,
  tables: Record<string, TableEntry>
) {
  return items.map((item, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (item.type === 'bullet') {
      return <li key={key}>{renderLineParts(item.text, key, equations, images, tables)}</li>;
    }
    if (item.type === 'table') {
      const [header, ...body] = item.rows;
      return (
        <table className="khbd-table" key={key}>
          <thead>
            <tr>
              {header.map((cell, ci) => (
                <th key={`${key}-h${ci}`}>{renderLineParts(cell, `${key}-h${ci}`, equations, images, tables)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={`${key}-r${ri}`}>
                {row.map((cell, ci) => (
                  <td key={`${key}-r${ri}c${ci}`}>{renderLineParts(cell, `${key}-r${ri}c${ci}`, equations, images, tables)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (/\[\[TBL:/.test(item.text)) {
      return <Fragment key={key}>{renderLineParts(item.text, key, equations, images, tables)}</Fragment>;
    }
    return <p key={key}>{renderInline(item.text, key, equations, images)}</p>;
  });
}

function renderMultiline(
  text: string,
  keyPrefix: string,
  equations: Record<string, EquationEntry>,
  images: Record<string, ImageEntry>,
  tables: Record<string, TableEntry>
) {
  return renderContentLines(parseContentLines(text), keyPrefix, equations, images, tables);
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
  images: Record<string, ImageEntry>,
  tables: Record<string, TableEntry>
) {
  const { headers, rows, soText, ktText } = merged;
  return (
    <table className="khbd-table khbd-table--merged" key={`${keyPrefix}-merged`}>
      <thead>
        <tr>
          {headers.map((h, ci) => (
            <th key={`${keyPrefix}-h${ci}`}>{renderLineParts(h, `${keyPrefix}-h${ci}`, equations, images, tables)}</th>
          ))}
          {soText !== null && <th className="khbd-table__so-th">Năng lực số</th>}
          {ktText !== null && <th className="khbd-table__kt-th">Giáo dục hòa nhập (HSKT)</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={`${keyPrefix}-r${ri}`}>
            {row.map((cell, ci) => (
              <td key={`${keyPrefix}-r${ri}c${ci}`}>{renderLineParts(cell, `${keyPrefix}-r${ri}c${ci}`, equations, images, tables)}</td>
            ))}
            {soText !== null && ri === 0 && (
              <td className="khbd-table__so-td" rowSpan={rows.length}>
                {renderMultiline(soText, `${keyPrefix}-so`, equations, images, tables)}
              </td>
            )}
            {ktText !== null && ri === 0 && (
              <td className="khbd-table__kt-td" rowSpan={rows.length}>
                {renderMultiline(ktText, `${keyPrefix}-kt`, equations, images, tables)}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function LessonPlanPreview({ markdown, equations, images, tables, weekNumber, durationPeriods }: Props) {
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
          // Dùng chung pipeline nhận diện bảng/gạch đầu dòng (renderMultiline
          // -> parseContentLines) thay vì luôn hiện thành MỘT đoạn văn thô —
          // nếu không, một bảng Markdown lỡ nằm ngoài khối <<<GOC>>> (hoặc bị
          // AI "làm phẳng" mất dấu xuống dòng) sẽ hiện thành đoạn văn có dấu
          // "|" lộ liễu thay vì bảng thật, giống lỗi đã gặp trong bản xuất Word.
          return <Fragment key={idx}>{renderMultiline(block.text, String(idx), equations, images, tables)}</Fragment>;
        }

        const hasSo = block.so.trim().length > 0;
        const hasKt = block.kt.trim().length > 0;
        const merged = trySectionMerge(block.goc, block.so, block.kt);

        if (merged) {
          return (
            <div className="khbd-merged" key={idx}>
              {merged.beforeTable.length > 0 && renderContentLines(merged.beforeTable, `${idx}-before`, equations, images, tables)}
              {renderMergedTable(merged, `${idx}`, equations, images, tables)}
            </div>
          );
        }

        const colCount = 1 + (hasSo ? 1 : 0) + (hasKt ? 1 : 0);

        return (
          <div className={`khbd-row khbd-row--cols-${colCount}`} key={idx}>
            <div className="khbd-col khbd-col--goc">
              {renderMultiline(block.goc, `${idx}-goc`, equations, images, tables)}
            </div>
            {hasSo && (
              <div className="khbd-col khbd-col--so">
                <p className="khbd-col__label khbd-col__label--so">Năng lực số</p>
                {renderMultiline(block.so, `${idx}-so`, equations, images, tables)}
              </div>
            )}
            {hasKt && (
              <div className="khbd-col khbd-col--kt">
                <p className="khbd-col__label khbd-col__label--kt">Giáo dục hòa nhập (HSKT)</p>
                {renderMultiline(block.kt, `${idx}-kt`, equations, images, tables)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
