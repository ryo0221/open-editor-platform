import {
  Document,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  ImageRun,
  ExternalHyperlink,
  Tab,
  CarriageReturn,
  Packer,
  HeadingLevel,
  WidthType,
  LevelFormat,
  AlignmentType,
  PageOrientation,
  TableLayoutType,
  ShadingType,
  VerticalMergeType,
  BorderStyle,
  type ParagraphChild,
  type IRunOptions,
  type IParagraphOptions,
} from 'docx';
import { canonicalJson, clone, deepFreeze } from '@editor-platform/artifact-core';
import { checkExportAbort, type DocumentExportAddress } from '@editor-platform/export-core';
import type { InlineSpan, DocumentTextStyle } from '@editor-platform/document/model';
import type { OwnedDocxPlan, DocumentDocxReport, DocumentDocxResult, DocxParagraph } from './types';

/** Only the private, fully resolved flow projection reaches the pinned library. No I/O here. */
export async function encodeOwnedDocx(
  plan: OwnedDocxPlan,
  signal?: AbortSignal,
): Promise<DocumentDocxResult> {
  if (!plan.font) throw Error('Missing document font plan');
  const report = clone(plan.report) as DocumentDocxReport;
  const font = (code = false) => {
    const f = code ? plan.codeFont : plan.font;
    if (!f) throw Error('Missing planned code font');
    return { ascii: f.family, hAnsi: f.family, eastAsia: f.family, cs: f.family };
  };
  const blockMap = new Map(report.blocks.map((b) => [b.address.blockId, b]));
  const detailMap = new Map(
    report.details.map((d) => [d.kind + '/' + canonicalJson(d.address), d]),
  );
  const mapPart = (
    address: DocumentExportAddress,
    part: string,
    kind?: 'paragraph' | 'cell' | 'image',
  ) => {
    const file = 'word/document.xml#' + part;
    const block = blockMap.get(address.blockId);
    if (block && !block.outputPartNames.includes(file)) block.outputPartNames.push(file);
    const detail = kind && detailMap.get(kind + '/' + canonicalJson(address));
    if (detail && !detail.outputPartNames.includes(file)) detail.outputPartNames.push(file);
  };
  let pIndex = 0,
    tableIndex = 0,
    imageIndex = 0;
  const runs = (spans: InlineSpan[], header = false, style?: DocumentTextStyle): ParagraphChild[] =>
    spans.map((s) => {
      const children: NonNullable<IRunOptions['children']>[number][] = [];
      for (const part of s.text.split(/(\r\n|\r|\n|\t)/))
        if (part === '\t') children.push(new Tab());
        else if (/^[\r\n]+$/.test(part)) children.push(new CarriageReturn());
        else if (part) children.push(part);
      const run = new TextRun({
        children,
        font: font(s.code || style?.fontFamily === 'Noto Sans Mono CJK JP'),
        size: style?.fontSize !== undefined ? Math.round(style.fontSize * 2) : undefined,
        bold:
          s.bold ??
          (header ? true : style?.fontWeight === undefined ? undefined : style.fontWeight === 700),
        italics: !!s.italic,
        strike: !!s.strike,
        underline: s.underline ? {} : undefined,
        color: (s.color ?? style?.color)?.slice(1),
        shading:
          (s.highlight ?? style?.highlight)
            ? {
                type: ShadingType.CLEAR,
                fill: (s.highlight ?? style!.highlight!).slice(1),
                color: 'auto',
              }
            : undefined,
        language: { value: 'ja-JP', eastAsia: 'ja-JP' },
      });
      return s.link ? new ExternalHyperlink({ link: s.link, children: [run] }) : run;
    });
  const heading = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ];
  const makeParagraph = (p: DocxParagraph, header = false) => {
    mapPart(p.address, `p:${++pIndex}`, 'paragraph');
    const options: IParagraphOptions = {
      children: runs(p.runs, header, p.style),
      heading: p.heading ? heading[p.heading - 1] : undefined,
      style: p.role === 'code' ? 'EditorCode' : p.role === 'caption' ? 'EditorCaption' : undefined,
      alignment: p.align === 'justify' ? AlignmentType.JUSTIFIED : p.align,
      indent: p.numbering
        ? { left: (p.numbering.level + 1) * 360 + Math.round(p.indent * 15), hanging: 180 }
        : { left: Math.round(p.indent * 15) },
      numbering: p.numbering,
      spacing: p.style
        ? {
            before:
              p.style.spaceBefore !== undefined ? Math.round(p.style.spaceBefore * 20) : undefined,
            after:
              p.style.spaceAfter !== undefined ? Math.round(p.style.spaceAfter * 20) : undefined,
            line:
              p.style.lineHeight !== undefined ? Math.round(p.style.lineHeight * 240) : undefined,
          }
        : undefined,
      keepNext: !!p.heading,
      keepLines: false,
      widowControl: true,
      // Native flowing text, including code: no exact heights, page frames or clipping.
    };
    return new Paragraph(options);
  };
  const children: (Paragraph | Table)[] = [];
  for (const [index, node] of plan.nodes.entries()) {
    checkExportAbort(signal);
    if (index % 32 === 31) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkExportAbort(signal);
    }
    if (node.kind === 'paragraph') children.push(makeParagraph(node));
    else if (node.kind === 'image') {
      const asset = plan.assets.get(node.assetKey);
      if (!asset || !['image/png', 'image/jpeg'].includes(asset.mime))
        throw Error('Unplanned image encoding');
      mapPart(node.address, `image:${++imageIndex}`, 'image');
      mapPart(node.address, `p:${++pIndex}`);
      children.push(
        new Paragraph({
          children: [
            new ImageRun({
              type: asset.mime === 'image/jpeg' ? 'jpg' : 'png',
              data: asset.bytes,
              transformation: { width: node.width, height: node.height },
              altText: {
                id: String(imageIndex),
                title: '',
                description: node.alt,
                name: `image${imageIndex}`,
              },
            }),
          ],
          keepNext: false,
          keepLines: false,
        }),
      );
    } else {
      const tablePart = `table:${++tableIndex}`;
      mapPart(node.address, tablePart);
      // Writer/Word can join adjacent w:tbl elements into one table. Keep native
      // block boundaries with an empty flowing separator (no source text added).
      if (children.at(-1) instanceof Table) {
        children.push(new Paragraph({ children: [], spacing: { before: 0, after: 0, line: 120 } }));
        pIndex++;
      }
      children.push(
        new Table({
          layout: TableLayoutType.FIXED,
          width: {
            size: Math.round(node.widths.reduce((a, b) => a + b, 0) * 15),
            type: WidthType.DXA,
          },
          columnWidths: node.widths.map((w) => Math.round(w * 15)),
          margins: { top: 80, bottom: 80, left: 90, right: 90 },
          borders: Object.fromEntries(
            ['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map((key) => [
              key,
              { style: BorderStyle.SINGLE, size: 4, color: '98A6BC' },
            ]),
          ),
          rows: node.rows.map(
            (row, r) =>
              new TableRow({
                tableHeader: row.header || undefined,
                cantSplit: false,
                children: row.cells.map((cell, c) => {
                  if (cell.merge !== 'continue')
                    mapPart(cell.address, `${tablePart}/row:${r + 1}/cell:${c + 1}`, 'cell');
                  const paragraphs = cell.paragraphs.map((p) => makeParagraph(p, cell.header));
                  // Word requires one paragraph even in an intentionally empty or continued cell.
                  if (!paragraphs.length) {
                    pIndex++;
                    paragraphs.push(new Paragraph({ children: [] }));
                  }
                  return new TableCell({
                    children: paragraphs,
                    columnSpan: cell.columns,
                    verticalMerge:
                      cell.merge === 'restart'
                        ? VerticalMergeType.RESTART
                        : cell.merge === 'continue'
                          ? VerticalMergeType.CONTINUE
                          : undefined,
                    width: {
                      size: Math.round(
                        node.widths
                          .slice(cell.column, cell.column + cell.columns)
                          .reduce((a, b) => a + b, 0) * 15,
                      ),
                      type: WidthType.DXA,
                    },
                    shading: cell.header
                      ? { fill: 'EDF1F7', type: ShadingType.CLEAR, color: 'auto' }
                      : undefined,
                  });
                }),
              }),
          ),
        }),
      );
    }
  }
  const doc = new Document({
    creator: '',
    lastModifiedBy: '',
    title: '',
    subject: '',
    description: '',
    keywords: '',
    defaultTabStop: 400,
    styles: {
      default: {
        document: {
          run: { font: font(), size: 22, language: { value: 'ja-JP', eastAsia: 'ja-JP' } },
          paragraph: { spacing: { after: 120, line: 336 } },
        },
        ...Object.fromEntries(
          heading.map((_h, i) => [
            `heading${i + 1}`,
            {
              run: { font: font(), size: [40, 34, 30, 26, 24, 22][i], bold: true, color: '253044' },
              paragraph: {
                outlineLevel: i,
                keepNext: true,
                keepLines: false,
                spacing: { before: 240, after: 120 },
              },
            },
          ]),
        ),
      },
      paragraphStyles: [
        // Declare the default inheritance root for consumers that resolve style references explicitly.
        { id: 'Normal', name: 'Normal' },
        {
          id: 'EditorCode',
          name: 'Editor Code',
          basedOn: 'Normal',
          run: { font: plan.codeFont ? font(true) : font(), size: 20 },
          paragraph: {
            keepNext: false,
            keepLines: false,
            spacing: { before: 100, after: 100, line: 280 },
          },
        },
        {
          id: 'EditorCaption',
          name: 'Editor Caption',
          basedOn: 'Normal',
          run: { font: font(), size: 18, color: '526277' },
          paragraph: { keepNext: false, keepLines: false },
        },
      ],
    },
    numbering: {
      config: plan.numbering.map((n) => ({
        reference: n.reference,
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          start: level === n.level ? (n.start ?? 1) : 1,
          format: n.kind === 'number' ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: n.kind === 'number' ? `%${level + 1}.` : '•',
          alignment: AlignmentType.LEFT,
          style: {
            run: { font: font() },
            paragraph: { indent: { left: (level + 1) * 360, hanging: 180 } },
          },
        })),
      })),
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              // docx applies the landscape swap itself; the plan stores physical dimensions.
              width: plan.page.landscape ? plan.page.height : plan.page.width,
              height: plan.page.landscape ? plan.page.width : plan.page.height,
              orientation: plan.page.landscape
                ? PageOrientation.LANDSCAPE
                : PageOrientation.PORTRAIT,
            },
            margin: {
              top: plan.page.margin,
              bottom: plan.page.margin,
              left: plan.page.margin,
              right: plan.page.margin,
            },
          },
        },
        children,
      },
    ],
  });
  checkExportAbort(signal);
  const bytes = new Uint8Array(await Packer.toArrayBuffer(doc));
  checkExportAbort(signal);
  return {
    status: 'ok',
    bytes,
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    report: deepFreeze(report),
  };
}
