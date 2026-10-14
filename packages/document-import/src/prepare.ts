import { clone } from '@editor-platform/artifact-core';
import {
  isDocument,
  nestedLists,
  type DocumentContent,
  type DocumentBlock,
  type DocumentListItem,
} from '@editor-platform/document/model';
import {
  attribute,
  namespaces as ns,
  ImportError,
  ImportReportBuilder,
  inspectOfficePackage,
  ownOfficeImportPlan,
  importNativeId,
  importLimits,
  checkImportAbort,
  type XmlNode,
  type ImportMapping,
} from '@editor-platform/office-import-core';
import {
  wc,
  ws,
  wa,
  integer,
  address,
  unknownChildren,
  type DocumentImportContext,
} from './context';
import { WordStyles } from './styles';
import { WordNumbering } from './numbering';
import { WordImages } from './images';
import { WordParagraphs, type ParsedParagraph } from './paragraph';
import { WordTables } from './table';
import type { DocumentImportOptions, DocumentImportAdapters, DocumentImportPlan } from './types';
export const documentImporterVersion = '1.0.0';
function pageSettings(
  section: XmlNode | undefined,
  context: DocumentImportContext,
): NonNullable<DocumentContent['page']> {
  if (!section) return { size: 'A4', margin: 64 };
  const { builder, pkg } = context,
    size = wc(section, 'pgSz'),
    margin = wc(section, 'pgMar');
  const w = integer(wa(size, 'w'), 11906),
    h = integer(wa(size, 'h'), 16838);
  if (w <= 0 || h <= 0) throw new ImportError('PAGE_GEOMETRY', 'Invalid Word page size');
  const landscape = w > h,
    short = Math.min(w, h),
    long = Math.max(w, h);
  let nativeSize: 'A4' | 'Letter' = 'A4';
  if (Math.abs(short - 12240) < 30 && Math.abs(long - 15840) < 30) nativeSize = 'Letter';
  else if (!(Math.abs(short - 11906) < 30 && Math.abs(long - 16838) < 30))
    builder.unsupported(
      'PAGE_SIZE',
      address(size ?? section),
      'Only A4/Letter sizes are represented. Explicit exclusion of source size uses native A4.',
    );
  const margins = ['top', 'right', 'bottom', 'left'].map((k) => integer(wa(margin, k), 960) / 15);
  const nativeMargin = Math.max(24, Math.min(160, Math.min(...margins)));
  if (margins.some((n) => n !== nativeMargin) || integer(wa(margin, 'gutter'), 0) !== 0)
    builder.add(
      'PAGE_MARGINS',
      'approximation',
      address(margin ?? section),
      'Native Document has one 24–160px margin; asymmetric/out-of-range margins use the clamped minimum and no gutter.',
      true,
    );
  unknownChildren(
    section,
    [
      'pgSz',
      'pgMar',
      'type',
      'cols',
      'docGrid',
      'pgNumType',
      'titlePg',
      'formProt',
      'textDirection',
      'headerReference',
      'footerReference',
      'footnotePr',
      'endnotePr',
      'vAlign',
      'bidi',
      'rtlGutter',
      'lnNumType',
      'paperSrc',
    ],
    context,
  );
  for (const n of section.children) {
    if (n.uri !== ns.w) continue;
    if (n.local === 'headerReference' || n.local === 'footerReference') {
      pkg.relationship(
        n.part,
        attribute(n, 'id', ns.rel) ?? '',
        n.local === 'headerReference' ? 'header' : 'footer',
      );
      builder.unsupported(
        'HEADER_FOOTER',
        address(n),
        'Header/footer content is outside native Document flow. Explicit exclusion removes it.',
      );
    } else if (n.local === 'cols' && (integer(wa(n, 'num'), 1) !== 1 || ws(n, 'col').length > 1))
      builder.unsupported(
        'MULTIPLE_COLUMNS',
        address(n),
        'Multiple columns are not retained. Exclusion uses one flowing column.',
      );
    else if (n.local === 'textDirection' && !['lrTb', 'lr'].includes(wa(n, 'val') ?? ''))
      builder.unsupported(
        'PAGE_DIRECTION',
        address(n),
        'Vertical page text is unsupported. Exclusion uses horizontal flow.',
      );
    else if (
      [
        'docGrid',
        'pgNumType',
        'titlePg',
        'footnotePr',
        'endnotePr',
        'vAlign',
        'bidi',
        'rtlGutter',
        'lnNumType',
        'paperSrc',
      ].includes(n.local)
    )
      builder.add(
        'PAGE_LAYOUT',
        'approximation',
        address(n),
        `${n.local} is not retained; native page flow replaces Word pagination settings.`,
        true,
      );
  }
  return { size: nativeSize, margin: nativeMargin, ...(landscape ? { landscape: true } : {}) };
}
export async function prepareDocumentImport(
  source: { bytes: Uint8Array; format: 'docx' },
  options: DocumentImportOptions,
  requestId: string,
  adapters: DocumentImportAdapters = { version: 'no-image-decoder' },
  signal?: AbortSignal,
): Promise<DocumentImportPlan> {
  const opts = clone(options),
    version = adapters.version,
    decoder = adapters.decodeImage;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
    throw new ImportError('REQUEST_ID', 'Invalid creation request ID');
  if (typeof version !== 'string' || !version)
    throw new ImportError('ADAPTER_VERSION', 'Image adapter version is required');
  const pkg = await inspectOfficePackage(source, signal),
    builder = new ImportReportBuilder(opts),
    mapping: ImportMapping[] = [];
  let index = 0;
  const context: DocumentImportContext = {
    pkg,
    builder,
    mapping,
    id: (prefix = 'block') => importNativeId(requestId, index++, prefix),
  };
  const root = pkg.xml(pkg.mainPart),
    bodies = ws(root, 'body');
  if (bodies.length !== 1)
    throw new ImportError('INVALID_DOCUMENT', 'Expected one Word document body');
  // Revisions may change properties, numbering or displayed content. Never choose
  // accepted/rejected text on the caller's behalf, even with exclusion consent.
  const revisions = new Set([
    'ins',
    'del',
    'moveFrom',
    'moveTo',
    'moveFromRangeStart',
    'moveFromRangeEnd',
    'moveToRangeStart',
    'moveToRangeEnd',
    'cellIns',
    'cellDel',
    'cellMerge',
    'numberingChange',
    'delText',
  ]);
  for (const part of pkg.parts.filter((p) => /\.xml$/i.test(p))) {
    const walk = (n: XmlNode) => {
      if (n.uri === ns.w && (revisions.has(n.local) || n.local.endsWith('PrChange')))
        throw new ImportError(
          'TRACKED_CHANGES',
          `${part}${n.path}: resolve tracked changes in a copy before import`,
        );
      for (const c of n.children) walk(c);
    };
    walk(pkg.xml(part));
  }
  const body = bodies[0];
  if (body.children.filter((n) => n.local !== 'sectPr').length > importLimits.blocks)
    throw new ImportError('BLOCK_LIMIT', 'DOCX exceeds 2,000 top-level source blocks');
  const sections = ws(body, 'sectPr');
  if (sections.length > 1 || (sections.length === 1 && body.children.at(-1) !== sections[0]))
    throw new ImportError(
      'SECTION_STRUCTURE',
      'Final section properties must appear once at the end of the body',
    );
  unknownChildren(root, ['body', 'background'], context);
  if (wc(root, 'background'))
    builder.unsupported(
      'PAGE_BACKGROUND',
      address(wc(root, 'background')!),
      'Word page background is not retained. Exclusion uses the native white page.',
    );
  const page = pageSettings(sections[0], context),
    styles = new WordStyles(context),
    numbering = new WordNumbering(context),
    images = new WordImages(context, decoder, signal),
    paragraphs = new WordParagraphs(context, styles, numbering, images),
    tables = new WordTables(context, paragraphs, styles);
  const blocks: DocumentBlock[] = [];
  interface ListScope {
    sourceLevel: number;
    numId: string;
    kind: 'number' | 'bullet';
    items: DocumentListItem[];
    listId: string;
    next: number;
  }
  let stack: ListScope[] = [];
  function addParagraph(parsed: ParsedParagraph) {
    const { list, number, source } = parsed;
    if (!list) {
      stack = [];
      blocks.push(...parsed.blocks);
      return;
    }
    const paragraph = parsed.blocks[0];
    if (!paragraph) return;
    let scope = stack.find((s) => s.sourceLevel === list.level);
    if (scope && (scope.numId !== list.numId || scope.kind !== list.kind || scope.next !== number))
      scope = undefined;
    if (scope) stack = stack.slice(0, stack.indexOf(scope) + 1);
    else {
      // A deeper paragraph can use its own numbering instance (for example a
      // restarted nested list). Its level still nests beneath the preceding
      // parent. numId distinguishes sibling sequences, not the parent relation.
      while (stack.length && stack.at(-1)!.sourceLevel >= list.level) stack.pop();
      const parent = stack.at(-1),
        items: DocumentListItem[] = [],
        listId = context.id('list');
      if (parent && parent.items.length) {
        const item = parent.items.at(-1)!;
        (item.childLists ??= []).push({
          id: listId,
          type: list.kind === 'number' ? 'ordered_list' : 'bullet_list',
          items,
          ...(list.kind === 'number' && number !== 1 ? { start: number } : {}),
        });
        if (list.level !== parent.sourceLevel + 1)
          builder.add(
            'LIST_LEVEL_GAP',
            'approximation',
            address(source),
            'Missing intermediate Word list levels are collapsed to the next native nesting level; no empty items are invented.',
            true,
          );
      } else {
        stack = [];
        blocks.push({
          id: listId,
          type: list.kind === 'number' ? 'numbered-list' : 'bulleted-list',
          text: '',
          items,
          ...(list.kind === 'number' && number !== 1 ? { start: number } : {}),
        });
        if (list.level !== 0)
          builder.add(
            'LIST_LEVEL_BASE',
            'approximation',
            address(source),
            'A list without a parent item begins at the native top level; subsequent relative nesting remains.',
            true,
          );
      }
      scope = {
        sourceLevel: list.level,
        numId: list.numId,
        kind: list.kind,
        items,
        listId,
        next: number!,
      };
      stack.push(scope);
    }
    const item: DocumentListItem = {
      id: context.id('item'),
      paragraphId: paragraph.id,
      rich: paragraph.rich ?? [{ text: paragraph.text }],
    };
    scope.items.push(item);
    scope.next = number! + 1;
    mapping.push({ source: address(source), nativeIds: [scope.listId, item.id, paragraph.id] });
  }
  for (const [i, n] of body.children.entries()) {
    checkImportAbort(signal);
    if (i % 32 === 31) await new Promise<void>((r) => setTimeout(r, 0));
    if (n.uri === ns.w && n.local === 'p') addParagraph(await paragraphs.parse(n));
    else if (n.uri === ns.w && n.local === 'tbl') {
      stack = [];
      blocks.push(await tables.parse(n));
    } else if (!(n.uri === ns.w && n.local === 'sectPr')) {
      stack = [];
      builder.unsupported(
        'BODY_ELEMENT',
        address(n),
        `Unsupported body element ${n.local}. Explicit exclusion removes its entire displayed content.`,
      );
    }
    if (blocks.length > importLimits.blocks)
      throw new ImportError(
        'BLOCK_LIMIT',
        'Native result exceeds 2,000 blocks after image expansion',
      );
  }
  const listText = (items: DocumentListItem[]): string[] =>
    items.flatMap((i) => [
      i.rich.map((s) => s.text).join(''),
      ...nestedLists(i).flatMap((l) => listText(l.items)),
    ]);
  let text = 0;
  for (const b of blocks) {
    if (b.items) b.text = listText(b.items).join('\n');
    text +=
      b.text.length +
      (b.cells?.flat().reduce((n, s) => n + s.length, 0) ?? 0) +
      (b.alt?.length ?? 0);
  }
  if (text > importLimits.textCharacters)
    throw new ImportError('TEXT_LIMIT', 'More than 1,000,000 native text characters');
  for (const part of pkg.parts)
    if (/(^docProps\/|comments?|authors?|person|revision|customXml\/)/i.test(part))
      builder.add(
        'PRIVATE_METADATA_EXCLUDED',
        'excluded',
        { part, path: '/' },
        'Original metadata, comments, history and actor information are excluded.',
      );
  builder.add(
    'DOCUMENT_REFLOW',
    'approximation',
    address(body),
    'Content is editable native flow. Original Word page count, arbitrary styles and pagination are not retained.',
    true,
  );
  builder.finalize();
  const content: DocumentContent = { schemaVersion: 2, page, blocks };
  if (!isDocument(content))
    throw new ImportError('NATIVE_VALIDATION', 'Converted Document failed native validation');
  return ownOfficeImportPlan(
    content,
    {
      sourceHash: pkg.sourceHash,
      format: 'docx',
      profile: 'ooxml-transitional',
      parser: {
        name: 'saxes',
        version: '6.0.0',
        adapterVersion: `document-import/${documentImporterVersion};${version}`,
      },
      domain: 'document',
      requestId,
      diagnostics: builder.diagnostics,
      mapping,
    },
    opts,
    signal,
  );
}
