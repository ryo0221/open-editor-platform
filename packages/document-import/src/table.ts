import { ImportError, importLimits, type XmlNode } from '@editor-platform/office-import-core';
import type { DocumentBlock, InlineSpan } from '@editor-platform/document/model';
import {
  wc,
  ws,
  wa,
  value,
  integer,
  enabled,
  address,
  unknownChildren,
  type DocumentImportContext,
} from './context';
import { WordParagraphs } from './paragraph';
import { WordStyles } from './styles';
export class WordTables {
  private totalCells = 0;
  constructor(
    private context: DocumentImportContext,
    private paragraphs: WordParagraphs,
    private styles: WordStyles,
  ) {}
  async parse(table: XmlNode): Promise<DocumentBlock> {
    const { builder, mapping, id } = this.context;
    const grid = wc(table, 'tblGrid'),
      columns = ws(grid, 'gridCol'),
      rows = ws(table, 'tr'),
      count = columns.length;
    if (!count || !rows.length)
      throw new ImportError('TABLE_GRID', 'A table needs a nonempty rectangular grid');
    this.totalCells += count * rows.length;
    if (this.totalCells > importLimits.cells)
      throw new ImportError('TABLE_CELL_LIMIT', 'DOCX exceeds 50,000 logical table cells');
    const widths = columns.map((n) => integer(wa(n, 'w')) / 15);
    if (widths.some((n) => n <= 0 || n > 10000))
      throw new ImportError('TABLE_WIDTH', 'Invalid table column width');
    const cells = rows.map(() => Array<string>(count).fill('')),
      paragraphs: { id: string; rich: InlineSpan[] }[][][] = rows.map(() =>
        Array.from({ length: count }, () => []),
      ),
      headers = rows.map(() => Array<boolean>(count).fill(false)),
      merges: NonNullable<DocumentBlock['merges']> = [],
      active = new Map<
        number,
        { row: number; cols: number; merge?: NonNullable<DocumentBlock['merges']>[number] }
      >();
    const block: DocumentBlock = {
      id: id('table'),
      type: 'table',
      text: '',
      cells,
      cellParagraphs: paragraphs,
      cellHeaders: headers,
      columnWidths: widths,
      merges,
    };
    const props = wc(table, 'tblPr');
    this.styles.tableStyle(props);
    if (props) {
      unknownChildren(
        props,
        [
          'tblStyle',
          'tblW',
          'tblInd',
          'tblBorders',
          'shd',
          'tblLayout',
          'tblCellMar',
          'tblLook',
          'jc',
          'tblCaption',
          'tblDescription',
          'tblpPr',
          'tblOverlap',
          'bidiVisual',
        ],
        this.context,
      );
      for (const name of ['tblpPr', 'bidiVisual'])
        if (wc(props, name))
          builder.unsupported(
            'FLOATING_TABLE',
            address(wc(props, name)!),
            'Floating/right-to-left table placement is not retained. Exclusion flows this table normally.',
          );
    }
    builder.add(
      'TABLE_APPEARANCE',
      'approximation',
      address(table),
      'Grid widths, rectangular merges, cell paragraphs and inline marks remain editable. Native table borders, row sizing, padding, alignment and background styling replace Office table appearance.',
      true,
    );
    unknownChildren(table, ['tblPr', 'tblGrid', 'tr'], this.context);
    for (const [r, row] of rows.entries()) {
      const rowProps = wc(row, 'trPr');
      if (
        integer(value(rowProps, 'gridBefore'), 0) !== 0 ||
        integer(value(rowProps, 'gridAfter'), 0) !== 0
      )
        throw new ImportError(
          'TABLE_GRID',
          'Tables with omitted leading/trailing grid cells are outside the rectangular profile',
        );
      if (rowProps)
        unknownChildren(
          rowProps,
          [
            'tblHeader',
            'trHeight',
            'cantSplit',
            'jc',
            'gridBefore',
            'gridAfter',
            'wBefore',
            'wAfter',
          ],
          this.context,
        );
      unknownChildren(row, ['trPr', 'tc'], this.context);
      const header = enabled(wc(rowProps, 'tblHeader'));
      let col = 0;
      const seen = new Set<number>();
      for (const cell of ws(row, 'tc')) {
        const cellProps = wc(cell, 'tcPr'),
          span = integer(value(cellProps, 'gridSpan'), 1);
        if (span < 1 || col + span > count)
          throw new ImportError('TABLE_GRID', 'Cell span exceeds the rectangular grid');
        const vMerge = wc(cellProps, 'vMerge'),
          vertical = vMerge ? (wa(vMerge, 'val') ?? 'continue') : undefined;
        if (vertical && !['restart', 'continue'].includes(vertical))
          throw new ImportError('TABLE_MERGE', 'Invalid vertical merge value');
        if (wc(cellProps, 'hMerge'))
          throw new ImportError(
            'TABLE_MERGE',
            'Legacy hMerge is unsupported; use gridSpan in a resolved copy',
          );
        if (cellProps)
          unknownChildren(
            cellProps,
            [
              'tcW',
              'gridSpan',
              'vMerge',
              'tcBorders',
              'shd',
              'tcMar',
              'vAlign',
              'textDirection',
              'noWrap',
              'tcFitText',
              'hideMark',
            ],
            this.context,
          );
        if (
          wc(cellProps, 'textDirection') &&
          !['lrTb', 'lr'].includes(value(cellProps, 'textDirection') ?? '')
        )
          builder.unsupported(
            'CELL_TEXT_DIRECTION',
            address(wc(cellProps, 'textDirection')!),
            'Vertical cell text is not retained; exclusion uses native horizontal flow.',
          );
        unknownChildren(cell, ['tcPr', 'p'], this.context);
        const mappingStart = mapping.length;
        const parts: { id: string; rich: InlineSpan[] }[] = [];
        for (const p of ws(cell, 'p')) {
          const parsed = await this.paragraphs.parse(p, true);
          for (const b of parsed.blocks) {
            parts.push({ id: b.id, rich: b.rich ?? [{ text: b.text }] });
            if (b.type === 'heading')
              builder.add(
                'CELL_HEADING',
                'approximation',
                address(p),
                'Cell text keeps inline marks; a cell heading uses native cell paragraph semantics.',
                true,
              );
          }
        }
        if (!ws(cell, 'p').length)
          throw new ImportError('TABLE_CELL', 'Word cells require a paragraph');
        const text = parts.map((p) => p.rich.map((s) => s.text).join('')).join('\n');
        if (vertical === 'continue') {
          mapping.splice(mappingStart);
          const previous = active.get(col);
          if (!previous || previous.cols !== span)
            throw new ImportError(
              'TABLE_MERGE',
              'Vertical merge continuation has no matching rectangular anchor',
            );
          if (text)
            builder.unsupported(
              'MERGE_CONTINUATION_CONTENT',
              address(cell),
              'Hidden content in a continued merge is not imported. Explicit exclusion removes that hidden text.',
            );
          if (!previous.merge) {
            previous.merge = { row: previous.row, col, rows: r - previous.row + 1, cols: span };
            merges.push(previous.merge);
          } else previous.merge.rows = r - previous.row + 1;
          mapping.push({
            source: address(cell),
            nativeIds: [`${block.id}:cell:${previous.row}:${col}`],
          });
        } else {
          active.delete(col);
          cells[r][col] = text;
          paragraphs[r][col] = parts;
          headers[r][col] = header;
          if (vertical === 'restart') {
            const merge = span > 1 ? { row: r, col, rows: 1, cols: span } : undefined;
            if (merge) merges.push(merge);
            active.set(col, { row: r, cols: span, merge });
          } else if (span > 1) merges.push({ row: r, col, rows: 1, cols: span });
          mapping.push({
            source: address(cell),
            nativeIds: [`${block.id}:cell:${r}:${col}`, ...parts.map((p) => p.id)],
          });
        }
        for (let c = col; c < col + span; c++) {
          seen.add(c);
          if (c !== col) active.delete(c);
        }
        col += span;
      }
      if (col !== count)
        throw new ImportError('TABLE_GRID', 'Rows must cover the same logical columns');
      for (const c of active.keys()) if (!seen.has(c)) active.delete(c);
    }
    mapping.push({ source: address(table), nativeIds: [block.id] });
    builder.add(
      'NATIVE_TABLE',
      'native',
      address(table),
      'Table grid, rectangular horizontal/vertical merges and cell paragraph order remain native.',
    );
    return block;
  }
}
