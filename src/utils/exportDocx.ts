import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  Math as DocxMath,
} from 'docx';
import { saveAs } from 'file-saver';
import { parseKhbd } from './khbdParser';
import { mathNodeToDocxComponents } from './mathToDocx';
import type { EquationEntry } from '../types';

type ParaChild = TextRun | DocxMath;

/** Tách một dòng thành các run (text thường / công thức thật / công thức AI viết thêm bằng $...$). */
function inlineToRuns(line: string, equations: Record<string, EquationEntry>): ParaChild[] {
  const parts = line.split(/(\[\[EQ:[^\]]+\]\]|\$[^$]+\$)/g).filter((p) => p !== '');
  const runs: ParaChild[] = [];

  for (const part of parts) {
    const eqMatch = part.match(/^\[\[EQ:([^\]]+)\]\]$/);
    if (eqMatch) {
      const entry = equations[eqMatch[1]];
      if (entry?.convertible && entry.node) {
        runs.push(new DocxMath({ children: mathNodeToDocxComponents(entry.node) }));
      } else {
        runs.push(new TextRun({ text: `[công thức #${eqMatch[1]} — không trích được, xem file gốc]`, italics: true, color: 'A13D3D' }));
      }
      continue;
    }
    if (part.startsWith('$') && part.endsWith('$')) {
      runs.push(new TextRun({ text: part.slice(1, -1), italics: true, font: 'Cambria Math' }));
      continue;
    }
    if (part) runs.push(new TextRun({ text: part }));
  }

  return runs;
}

function textBlockToParagraphs(text: string, equations: Record<string, EquationEntry>): Paragraph[] {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return [new Paragraph({})];

  return lines.map((line) => {
    const trimmed = line.trim();
    const isBullet = trimmed.startsWith('- ') || trimmed.startsWith('* ');
    const content = isBullet ? trimmed.slice(2) : trimmed;
    return new Paragraph({
      bullet: isBullet ? { level: 0 } : undefined,
      children: inlineToRuns(content, equations),
    });
  });
}

/**
 * Xuất KHBD ra file .docx: mỗi mục là bảng 2 cột thật (không phải văn bản chen
 * dòng) — cột trái là nội dung giáo án, cột phải là năng lực số & giáo dục hòa
 * nhập, có nền màu để phân biệt rõ. Công thức toán trích được từ file gốc được
 * dựng lại thành object công thức Word thật (không phải chữ nghiêng giả lập).
 */
export async function exportLessonPlanToDocx(markdown: string, equations: Record<string, EquationEntry>, fileName: string) {
  const blocks = parseKhbd(markdown);
  const children: (Paragraph | Table)[] = [];

  for (const block of blocks) {
    if (block.type === 'heading') {
      const headingLevel = block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ heading: headingLevel, children: inlineToRuns(block.text, equations), spacing: { before: 240, after: 120 } }));
      continue;
    }

    if (block.type === 'text') {
      children.push(new Paragraph({ children: inlineToRuns(block.text, equations) }));
      continue;
    }

    // block.type === 'section' -> bảng 2 cột thật
    const leftParagraphs = textBlockToParagraphs(block.left, equations);
    const rightParagraphs = [
      new Paragraph({
        children: [new TextRun({ text: 'Năng lực số & Giáo dục hòa nhập', bold: true, color: 'C17A2B', size: 18 })],
        spacing: { after: 80 },
      }),
      ...textBlockToParagraphs(block.right, equations),
    ];

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                width: { size: 62, type: WidthType.PERCENTAGE },
                children: leftParagraphs,
                margins: { top: 120, bottom: 120, left: 120, right: 120 },
              }),
              new TableCell({
                width: { size: 38, type: WidthType.PERCENTAGE },
                shading: { type: ShadingType.CLEAR, fill: 'F2E2C8' },
                children: rightParagraphs,
                margins: { top: 120, bottom: 120, left: 120, right: 120 },
              }),
            ],
          }),
        ],
      }),
      new Paragraph({}) // khoảng cách sau bảng
    );
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const blob = await Packer.toBlob(doc);
  saveAs(blob, fileName.endsWith('.docx') ? fileName : `${fileName}.docx`);
}
