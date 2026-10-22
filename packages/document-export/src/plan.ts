import { clone, contentHash, deepFreeze } from '@editor-platform/artifact-core';
import {
  isDocument,
  nestedLists,
  type DocumentBlock,
  type DocumentContent,
  type DocumentListItem,
  type InlineSpan,
} from '@editor-platform/document/model';
import {
  captureExportSnapshot,
  checkExportAbort,
  exportAssetLimits,
  exportColor,
  exportDiagnostic,
  hashExportBytes,
  missingFontGlyphs,
  ownExportAsset,
  validExportBasis,
  validFontProfile,
  type CaptureBasis,
  type DocumentExportAddress,
  type ExportDiagnostic,
  type ExportFontProfile,
  type ExportAsset,
} from '@editor-platform/export-core';
import {
  documentDocxCapabilities as caps,
  type DocxAdapters,
  type DocumentDocxOptions,
  type DocumentExportSnapshot,
  type DocumentDocxPlan,
  type DocumentDocxReport,
  type OwnedDocxPlan,
  type DocxParagraph,
  type DocxTable,
  type DocxRepresentation,
} from './types';

export const documentDocxExporterVersion = '1.3.0';
const plans = new WeakMap<DocumentDocxPlan, OwnedDocxPlan>();
export const ownedDocumentDocxPlan = (plan: DocumentDocxPlan) => plans.get(plan);
export const captureDocumentExportSnapshot = (content: DocumentContent, basis: CaptureBasis) =>
  captureExportSnapshot(content, basis);
const register = (owned: OwnedDocxPlan): DocumentDocxPlan => {
  const plan = Object.freeze({ report: owned.report }) as DocumentDocxPlan;
  plans.set(plan, owned);
  return plan;
};

type DocxServices = ReturnType<typeof bindDocxServices>;
type Address = DocumentExportAddress;
type ListKind = 'bullet' | 'number' | 'check';
type BlockMerge = NonNullable<DocumentBlock['merges']>[number];
const codeFontFamily = 'Noto Sans Mono CJK JP';
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function bindDocxServices(adapters: DocxAdapters) {
  return {
    resolveFont: adapters?.resolveFont?.bind(adapters),
    resolveAsset: adapters?.resolveAsset?.bind(adapters),
    imagePng: adapters?.imagePng?.bind(adapters),
    renderMermaid: adapters?.renderMermaid?.bind(adapters),
  };
}
function ownPlanInput(snapshot: DocumentExportSnapshot, options: DocumentDocxOptions) {
  try {
    return {
      input: deepFreeze(clone(snapshot)) as DocumentExportSnapshot,
      settings: deepFreeze(clone(options)) as DocumentDocxOptions,
    };
  } catch {
    return undefined;
  }
}
function invalidInputMessage(
  input: DocumentExportSnapshot,
  settings: DocumentDocxOptions,
): string | undefined {
  let valid = false;
  try {
    valid = isDocument(input?.content) && validExportBasis(input?.basis);
  } catch {
    /* Malformed native input is an addressed, non-waivable preflight failure. */
  }
  if (!valid) return 'Invalid Document content or export basis';
  if (
    !settings ||
    typeof settings.fontProfileId !== 'string' ||
    !settings.fontProfileId ||
    settings.styleProfileId !== 'document-ja-1' ||
    !['reject', 'source', 'image'].includes(settings.mermaid) ||
    !['reject', 'source'].includes(settings.previewBlocks)
  )
    return 'Invalid Document export options';
}
function docxPage(content: DocumentContent) {
  const pageSettings = content.page ?? { size: 'A4', margin: 64, landscape: false };
  const size = pageSettings.size === 'A4' ? [11906, 16838] : [12240, 15840];
  const page = {
    width: size[pageSettings.landscape ? 1 : 0],
    height: size[pageSettings.landscape ? 0 : 1],
    margin: Math.round(pageSettings.margin * 15),
    landscape: !!pageSettings.landscape,
  };
  return { pageSettings, page };
}
function createPlanRun(
  input: DocumentExportSnapshot,
  settings: DocumentDocxOptions,
  services: DocxServices,
  signal?: AbortSignal,
) {
  const content = input.content as DocumentContent;
  const diagnostics: ExportDiagnostic<Address>[] = [];
  const ids = new Set<string>();
  const add = (
    code: string,
    severity: ExportDiagnostic['severity'],
    message: string,
    address?: Address,
    effect?: ExportDiagnostic['effect'],
  ) => {
    const d = exportDiagnostic(code, severity, message, address, effect);
    if (!ids.has(d.id)) {
      diagnostics.push(d);
      ids.add(d.id);
    }
  };
  const { pageSettings, page } = docxPage(content);
  return {
    input,
    settings,
    services,
    signal,
    content,
    diagnostics,
    add,
    pageSettings,
    page,
    bodyWidth: (page.width - page.margin * 2) / 15,
    bodyHeight: (page.height - page.margin * 2) / 15,
    nodes: [] as OwnedDocxPlan['nodes'],
    assets: new Map() as OwnedDocxPlan['assets'],
    numbering: [] as OwnedDocxPlan['numbering'],
    blocks: [] as DocumentDocxReport['blocks'],
    details: [] as DocumentDocxReport['details'],
    chars: 0,
    cells: 0,
    totalAssetBytes: 0,
    totalSourceBytes: 0,
    codeNeeded: false,
    sourceHashes: new Set<string>(),
    assetSources: new Map<string, string>(),
  };
}
type PlanRun = ReturnType<typeof createPlanRun>;

function addContentDiagnostics(run: PlanRun) {
  const { content, add, pageSettings } = run;
  if (content.reuse && (content.reuse.instances.length || content.reuse.artifactMode))
    add(
      'REUSABLE_LINKS_RESOLVED',
      'warning',
      'Exports the adopted native appearance. Library links, token modes, variant controls and typed slots are not retained in DOCX or restored by Office import.',
      { domain: 'document' },
      'editability',
    );
  if (content.blocks.length > caps.blocks)
    add('LIMIT_EXCEEDED', 'error', 'At most 2,000 top-level blocks can be exported');
  if (pageSettings.landscape !== undefined && typeof pageSettings.landscape !== 'boolean')
    add('PAGE_SETTINGS_INVALID', 'error', 'Page orientation must be a boolean');
}
function hasInvalidCharacter(text: string) {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      (code < 32 && ![9, 10, 13].includes(code)) ||
      code === 0xfffe ||
      code === 0xffff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return true;
  }
  return false;
}
function checkText(run: PlanRun, text: string, address: Address) {
  run.chars += text.length;
  if (hasInvalidCharacter(text))
    run.add(
      'TEXT_INVALID',
      'error',
      'Text contains characters that cannot be represented in Office XML',
      address,
    );
  if (run.chars > caps.textCharacters)
    run.add('LIMIT_EXCEEDED', 'error', 'At most 1,000,000 text characters can be exported', {
      domain: 'document',
    });
}
function richSpan(run: PlanRun, s: InlineSpan, i: number, address: Address, code: boolean) {
  const a = { ...address, path: `runs/${i}` },
    span = { ...s, ...(code ? { code: true } : {}) };
  checkText(run, span.text, address);
  if (span.code) run.codeNeeded = true;
  for (const key of ['color', 'highlight'] as const)
    if (span[key] !== undefined) {
      const c = exportColor(span[key]!);
      if (!c || c.alpha !== 1)
        run.add('COLOR_UNSUPPORTED', 'error', 'DOCX text colors must be opaque portable colors', a);
      else span[key] = '#' + c.hex;
    }
  if (span.link && !/^(https?:\/\/|mailto:)/i.test(span.link)) {
    run.add(
      'LINK_AS_TEXT',
      'warning',
      'This link becomes plain text; DOCX permits only HTTP, HTTPS and mailto links',
      a,
      'editability',
    );
    delete span.link;
  }
  return span;
}
const rich = (run: PlanRun, spans: InlineSpan[], address: Address, code = false): InlineSpan[] =>
  spans.map((s, i) => richSpan(run, s, i, address, code));
function paragraph(
  run: PlanRun,
  spans: InlineSpan[],
  address: Address,
  block: Pick<DocumentBlock, 'align' | 'indent' | 'style'> = {},
  role: DocxParagraph['role'] = 'body',
): DocxParagraph {
  run.details.push({ address, kind: 'paragraph', outputPartNames: [] });
  if (block.style?.fontFamily === codeFontFamily) run.codeNeeded = true;
  if (block.style?.fontSize !== undefined && !Number.isInteger(block.style.fontSize * 2))
    run.add(
      'STYLE_SIZE_QUANTIZED',
      'warning',
      'DOCX uses half-point font sizes; this style is rounded to the nearest half point',
      address,
      'appearance',
    );
  if ((block.indent ?? 0) * 24 >= run.bodyWidth)
    run.add('INDENT_EXCEEDS_BODY', 'error', 'Paragraph indentation leaves no body width', address);
  return {
    kind: 'paragraph',
    address,
    runs: rich(run, spans, address, role === 'code'),
    ...(block.style ? { style: { ...block.style } } : {}),
    align: block.align,
    indent: (block.indent ?? 0) * 24,
    role,
  };
}
async function ownAsset(run: PlanRun, value: ExportAsset, address: Address): Promise<string> {
  let asset = ownExportAsset(value);
  const sourceHash = await hashExportBytes(asset.bytes);
  if (!run.sourceHashes.has(sourceHash)) {
    run.sourceHashes.add(sourceHash);
    run.totalSourceBytes += asset.bytes.length;
    if (run.totalSourceBytes > exportAssetLimits.totalBytes)
      throw Error('Total resolved images exceed 64 MiB');
  }
  if (asset.mime === 'image/gif' || asset.mime === 'image/webp') {
    run.add(
      'IMAGE_STATIC_PNG',
      'warning',
      'GIF/WebP becomes a static PNG picture',
      address,
      'appearance',
    );
    if (!run.services.imagePng) throw Error('A static image conversion adapter is required');
    asset = ownExportAsset(await run.services.imagePng(ownExportAsset(asset), run.signal));
    checkExportAbort(run.signal);
    if (asset.mime !== 'image/png') throw Error('The image conversion did not return a PNG');
  }
  const hash = await hashExportBytes(asset.bytes);
  const key = asset.mime + '/' + hash;
  if (!run.assets.has(key)) {
    run.totalAssetBytes += asset.bytes.length;
    if (run.totalAssetBytes > exportAssetLimits.totalBytes)
      throw Error('Total image bytes exceed 64 MiB');
    run.assets.set(key, { ...asset, hash });
  }
  return key;
}
function addPicture(run: PlanRun, key: string, block: DocumentBlock, address: Address) {
  const asset = run.assets.get(key)!;
  const requested = block.width ?? asset.width;
  const availableWidth = run.bodyWidth - (block.indent ?? 0) * 24;
  const scale = Math.min(
    requested / asset.width,
    availableWidth / asset.width,
    run.bodyHeight / asset.height,
  );
  if (scale <= 0) {
    run.add('IMAGE_SIZE_INVALID', 'error', 'Image has no available body area', address);
    return;
  }
  if (scale < requested / asset.width)
    run.add(
      'IMAGE_SCALED_TO_BODY',
      'warning',
      'Image is proportionally reduced to fit the page body',
      address,
      'appearance',
    );
  const alt = block.alt ?? '';
  if (typeof alt !== 'string') {
    run.add('IMAGE_ALT_INVALID', 'error', 'Image alt text must be a string', address);
    return;
  }
  checkText(run, alt, address);
  run.nodes.push({
    kind: 'image',
    address,
    assetKey: key,
    width: asset.width * scale,
    height: asset.height * scale,
    alt,
  });
  run.details.push({ address, kind: 'image', outputPartNames: [] });
  if (block.caption)
    run.nodes.push(
      paragraph(run, [{ text: block.caption }], { ...address, path: 'caption' }, {}, 'caption'),
    );
}
function nestedListKind(nested: ReturnType<typeof nestedLists>[number], kind: ListKind): ListKind {
  if (nested.check ?? kind === 'check') return 'check';
  return nested.type === 'ordered_list' ? 'number' : 'bullet';
}
function list(
  run: PlanRun,
  items: DocumentListItem[],
  kind: ListKind,
  block: DocumentBlock,
  level: number,
  start = 1,
) {
  const address: Address = { domain: 'document', blockId: block.id };
  if (level > caps.maxListLevel) {
    run.add('LIST_DEPTH_EXCEEDED', 'error', 'Lists support levels 0 through 8', address);
    return;
  }
  const reference = `list${run.numbering.length + 1}`;
  if (kind !== 'check')
    run.numbering.push({ reference, kind, level, ...(start !== 1 ? { start } : {}) });
  else
    run.add(
      'CHECKBOX_STATIC',
      'warning',
      'Checked states become static [x] / [ ] text',
      address,
      'editability',
    );
  for (const item of items) {
    const p = paragraph(run, item.rich, { ...address, itemId: item.id }, block);
    if (kind === 'check') {
      p.runs.unshift({ text: item.checked ? '[x] ' : '[ ] ' });
      p.indent += (level + 1) * 24;
    } else p.numbering = { reference, level };
    run.nodes.push(p);
    for (const nested of nestedLists(item))
      list(run, nested.items, nestedListKind(nested, kind), block, level + 1, nested.start);
  }
}
function hasInvalidBlockStrings(block: DocumentBlock) {
  return ['caption', 'alt', 'language'].some((k) => {
    const v = block[k as 'caption'];
    return v !== undefined && typeof v !== 'string';
  });
}
function exportTextBlock(run: PlanRun, block: DocumentBlock, address: Address): DocxRepresentation {
  const p = paragraph(run, block.rich ?? [{ text: block.text }], address, block);
  if (block.type === 'heading') p.heading = block.level ?? 1;
  run.nodes.push(p);
  return 'native';
}
function listBlockKind(type: DocumentBlock['type']): ListKind {
  if (type === 'check-list') return 'check';
  return type === 'numbered-list' ? 'number' : 'bullet';
}
function exportListBlock(run: PlanRun, block: DocumentBlock): DocxRepresentation {
  const kind = listBlockKind(block.type);
  list(
    run,
    block.items ??
      block.text.split('\n').map((text, i) => ({ id: `${block.id}:item:${i}`, rich: [{ text }] })),
    kind,
    block,
    0,
    block.start,
  );
  if (
    kind === 'check' ||
    run.diagnostics.some((d) => d.code === 'CHECKBOX_STATIC' && d.address?.blockId === block.id)
  )
    return 'static-checkbox';
  return 'native';
}
function tableWidths(run: PlanRun, block: DocumentBlock, cols: number, address: Address) {
  const { bodyWidth } = run;
  const widths = block.columnWidths
    ? [...block.columnWidths]
    : Array<number>(cols).fill(bodyWidth / cols);
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum > bodyWidth) {
    widths.forEach((w, i) => (widths[i] = (w * bodyWidth) / sum));
    run.add(
      'TABLE_SCALED_TO_BODY',
      'warning',
      'Table columns are proportionally reduced to the body width',
      address,
      'appearance',
    );
  }
  return widths;
}
function tableMerges(block: DocumentBlock) {
  const merges = new Map<string, BlockMerge>();
  for (const m of block.merges ?? [])
    for (let r = m.row; r < m.row + m.rows; r++)
      for (let c = m.col; c < m.col + m.cols; c++) merges.set(`${r}:${c}`, m);
  return merges;
}
interface TableCellInput {
  block: DocumentBlock;
  address: Address;
  merge: BlockMerge | undefined;
  r: number;
  c: number;
  text: string;
}
function tableCell(run: PlanRun, { block, address, merge, r, c, text }: TableCellInput) {
  const continuation = !!merge && r > merge.row;
  const a = { ...address, cell: { row: r, column: c } };
  const parts = continuation
    ? []
    : (block.cellParagraphs?.[r]?.[c] ?? [
        { id: '', rich: block.cellRich?.[r]?.[c] ?? [{ text }] },
      ]);
  const paragraphs = parts.map((part, p) => paragraph(run, part.rich, { ...a, paragraph: p }));
  const header = block.cellHeaders?.[r]?.[c] ?? r === 0;
  const cell: DocxTable['rows'][number]['cells'][number] = {
    address: a,
    column: c,
    columns: merge?.cols ?? 1,
    merge: merge && merge.rows > 1 ? (continuation ? 'continue' : 'restart') : undefined,
    paragraphs,
    header,
  };
  if (!continuation) run.details.push({ address: a, kind: 'cell', outputPartNames: [] });
  return cell;
}
function isRepeatingHeaderRow(block: DocumentBlock, r: number, cols: number) {
  return (
    !!block.cellHeaders?.[r] &&
    block.cellHeaders[r].length === cols &&
    block.cellHeaders[r].every((v) => v === true)
  );
}
function exportTableBlock(
  run: PlanRun,
  block: DocumentBlock,
  address: Address,
): DocxRepresentation | undefined {
  const source = block.cells!,
    cols = source[0].length;
  run.cells += source.length * cols;
  if (run.cells > caps.logicalCells) {
    run.add(
      'TABLE_LIMIT_EXCEEDED',
      'error',
      'At most 50,000 logical table cells can be exported',
      address,
    );
    return;
  }
  const widths = tableWidths(run, block, cols, address);
  const table: DocxTable = { kind: 'table', address, widths, rows: [] };
  const merges = tableMerges(block);
  let repeating = true;
  source.forEach((row, r) => {
    // Do not infer a repeated header from first-row position in legacy content.
    repeating = repeating && isRepeatingHeaderRow(block, r, cols);
    const outputRow: DocxTable['rows'][number] = { header: repeating, cells: [] };
    row.forEach((text, c) => {
      const merge = merges.get(`${r}:${c}`);
      if (merge && c !== merge.col) return;
      outputRow.cells.push(tableCell(run, { block, address, merge, r, c, text }));
    });
    table.rows.push(outputRow);
  });
  run.nodes.push(table);
  return 'native';
}
async function exportImageBlock(
  run: PlanRun,
  block: DocumentBlock,
  address: Address,
): Promise<DocxRepresentation> {
  const { services, signal } = run;
  try {
    if (!block.src || !services.resolveAsset)
      throw Error('An image source and resolver are required');
    let key = run.assetSources.get(block.src);
    if (!key) {
      key = await ownAsset(run, await services.resolveAsset(block.src, signal), address);
      run.assetSources.set(block.src, key);
    }
    checkExportAbort(signal);
    addPicture(run, key, block, address);
  } catch {
    checkExportAbort(signal);
    run.add(
      'ASSET_FAILED',
      'error',
      'Image could not be resolved, decoded or kept within the declared limits',
      address,
    );
  }
  return 'native';
}
async function exportMermaidImageBlock(
  run: PlanRun,
  block: DocumentBlock,
  address: Address,
): Promise<DocxRepresentation | undefined> {
  const { services, signal } = run;
  checkText(run, block.text, address);
  if (run.chars > caps.textCharacters) return;
  run.add(
    'MERMAID_RASTERIZED',
    'warning',
    'The Mermaid diagram becomes a picture',
    address,
    'editability',
  );
  try {
    if (!services.renderMermaid) throw Error('A Mermaid renderer is required');
    const key = await ownAsset(run, await services.renderMermaid(block.text, signal), address);
    checkExportAbort(signal);
    if (run.assets.get(key)!.mime !== 'image/png') throw Error('Mermaid rendering must return PNG');
    addPicture(run, key, { ...block, alt: block.alt ?? 'Mermaid diagram' }, address);
  } catch {
    checkExportAbort(signal);
    run.add('MERMAID_FAILED', 'error', 'Mermaid syntax or rendering failed', address);
  }
  return 'png';
}
function isSourceBlock(block: DocumentBlock, settings: DocumentDocxOptions) {
  return (
    block.type === 'code' ||
    (block.type === 'mermaid' && settings.mermaid === 'source') ||
    (['html', 'react-preview'].includes(block.type) && settings.previewBlocks === 'source')
  );
}
function exportSourceBlock(run: PlanRun, block: DocumentBlock, address: Address) {
  let representation: DocxRepresentation = 'native';
  if (block.type !== 'code') {
    representation = 'source';
    run.add(
      block.type === 'mermaid' ? 'MERMAID_AS_SOURCE' : 'PREVIEW_AS_SOURCE',
      'warning',
      'The block becomes escaped source text; preview code is never executed',
      address,
      'appearance',
    );
  }
  const label = block.type === 'code' ? block.language : block.type;
  if (label)
    run.nodes.push(
      paragraph(run, [{ text: label }], { ...address, path: 'language' }, {}, 'caption'),
    );
  run.nodes.push(paragraph(run, [{ text: block.text }], address, block, 'code'));
  return representation;
}
const isAdapterBlock = (block: DocumentBlock, settings: DocumentDocxOptions) =>
  block.type === 'image' || (block.type === 'mermaid' && settings.mermaid === 'image');
function exportAdapterBlock(run: PlanRun, block: DocumentBlock, address: Address) {
  return block.type === 'image'
    ? exportImageBlock(run, block, address)
    : exportMermaidImageBlock(run, block, address);
}
function exportLocalBlock(
  run: PlanRun,
  block: DocumentBlock,
  address: Address,
): DocxRepresentation | undefined {
  if (block.type === 'heading' || block.type === 'paragraph')
    return exportTextBlock(run, block, address);
  if (['bulleted-list', 'numbered-list', 'check-list'].includes(block.type))
    return exportListBlock(run, block);
  if (block.type === 'table') return exportTableBlock(run, block, address);
  if (isSourceBlock(block, run.settings)) return exportSourceBlock(run, block, address);
  run.add(
    'BLOCK_UNSUPPORTED',
    'error',
    'Select an explicit image/source policy for this block',
    address,
  );
  return 'native';
}
async function exportBlocks(run: PlanRun) {
  const { content, signal } = run;
  // Keep pathological limits from invoking asset/font adapters. Validation never truncates success.
  if (content.blocks.length > caps.blocks) return;
  for (const [blockIndex, block] of content.blocks.entries()) {
    if (block.hidden) continue;
    checkExportAbort(signal);
    if (blockIndex % 32 === 31) await yieldToEventLoop();
    const address: Address = { domain: 'document', blockId: block.id };
    if (hasInvalidBlockStrings(block)) {
      run.add(
        'INVALID_CONTENT',
        'error',
        'Caption, alt text and language must be strings',
        address,
      );
      continue;
    }
    const representation = isAdapterBlock(block, run.settings)
      ? await exportAdapterBlock(run, block, address)
      : exportLocalBlock(run, block, address);
    if (representation) run.blocks.push({ address, representation, outputPartNames: [] });
  }
}
async function loadFont(run: PlanRun, id: string) {
  const { services, signal } = run;
  try {
    if (!services.resolveFont) throw Error('Missing font resolver');
    const f = deepFreeze(clone(await services.resolveFont(id, signal)));
    checkExportAbort(signal);
    if (!validFontProfile(f, id)) throw Error('Invalid font profile');
    if (!f.verified)
      run.add(
        'FONT_UNVERIFIED',
        'warning',
        `Font ${f.family} ${f.version} was not verified`,
        { domain: 'document', path: `font/${id}` },
        'appearance',
      );
    return f;
  } catch {
    checkExportAbort(signal);
    run.add('FONT_INVALID', 'error', 'A complete matching font profile is required', {
      domain: 'document',
      path: `font/${id}`,
    });
  }
}
interface DocxFonts {
  font: ExportFontProfile | undefined;
  codeFont: ExportFontProfile | undefined;
}
function verifyParagraph(run: PlanRun, { font, codeFont }: DocxFonts, p: DocxParagraph) {
  if (p.style?.fontFamily) {
    const selected = p.style.fontFamily === codeFontFamily ? codeFont : font;
    if (selected && selected.family !== p.style.fontFamily)
      run.add(
        'STYLE_FONT_UNAVAILABLE',
        'error',
        'The resolved font profile does not match the named style font',
        p.address,
      );
  }
  for (const span of p.runs) {
    const f = span.code || p.style?.fontFamily === codeFontFamily ? codeFont : font;
    if (f && missingFontGlyphs(span.text, f).length)
      run.add(
        'GLYPH_MISSING',
        'error',
        'The selected font lacks one or more required glyphs',
        p.address,
      );
  }
}
function verifyFonts(run: PlanRun, fonts: DocxFonts) {
  const { font } = fonts;
  if (font && run.numbering.some((n) => n.kind === 'bullet') && missingFontGlyphs('•', font).length)
    run.add('GLYPH_MISSING', 'error', 'The selected font lacks the list bullet glyph');
  const verify = (p: DocxParagraph) => verifyParagraph(run, fonts, p);
  for (const n of run.nodes) {
    if (n.kind === 'paragraph') verify(n);
    else if (n.kind === 'table')
      for (const r of n.rows) for (const c of r.cells) c.paragraphs.forEach(verify);
  }
}
function addReflowDiagnostics(run: PlanRun, font: ExportFontProfile | undefined) {
  run.add(
    'DOCX_REFLOW_EXPECTED',
    'info',
    'Office reflows this document; line breaks and page count can differ from the Editor',
  );
  run.add(
    'FONT_NOT_EMBEDDED',
    'info',
    `Recipients need ${font?.family ?? run.settings.fontProfileId}${run.codeNeeded ? ' and Noto Sans Mono CJK JP' : ''}; fonts are referenced, not embedded`,
  );
}
function representationCounts(blocks: DocumentDocxReport['blocks']) {
  const counts = { native: 0, converted: 0, rasterized: 0 };
  for (const b of blocks)
    counts[
      b.representation === 'native'
        ? 'native'
        : b.representation === 'png'
          ? 'rasterized'
          : 'converted'
    ]++;
  return counts;
}
function planHashInput(run: PlanRun, { font, codeFont }: DocxFonts) {
  return {
    exporterVersion: documentDocxExporterVersion,
    basis: run.input.basis,
    options: run.settings,
    font,
    codeFont,
    page: run.page,
    nodes: run.nodes,
    numbering: run.numbering,
    assets: [...run.assets].map(([key, a]) => ({
      key,
      hash: a.hash,
      mime: a.mime,
      width: a.width,
      height: a.height,
    })),
    diagnostics: run.diagnostics.map(({ id, code, severity, effect, requiresAcceptance }) => ({
      id,
      code,
      severity,
      effect,
      requiresAcceptance,
    })),
  };
}

export async function prepareDocumentDocx(
  snapshot: DocumentExportSnapshot,
  options: DocumentDocxOptions,
  adapters: DocxAdapters,
  signal?: AbortSignal,
): Promise<DocumentDocxPlan> {
  checkExportAbort(signal);
  const owned = ownPlanInput(snapshot, options);
  if (!owned) return invalidPlan('Input must be serializable domain data');
  const { input, settings } = owned;
  const services = bindDocxServices(adapters);
  const invalid = invalidInputMessage(input, settings);
  if (invalid) return invalidPlan(invalid, input?.basis);
  const run = createPlanRun(input, settings, services, signal);
  const { content, add } = run;
  if (content.blocks.some((b) => b.reference))
    add(
      'REFERENCE_EXPORT_UNSUPPORTED',
      'error',
      '参照埋め込みのDOCX出力は未対応です。HTML／Markdownまたは参照付きnative JSONを使ってください。',
      { domain: 'document' },
    );
  if ((await contentHash(content)) !== input.basis.contentHash)
    add('SNAPSHOT_HASH_MISMATCH', 'error', 'Captured content does not match its declared hash');
  addContentDiagnostics(run);
  await exportBlocks(run);
  const fonts: DocxFonts = { font: undefined, codeFont: undefined };
  if (!run.diagnostics.some((d) => d.severity === 'error')) {
    fonts.font = await loadFont(run, settings.fontProfileId);
    if (run.codeNeeded) fonts.codeFont = await loadFont(run, caps.codeFontProfileId);
  }
  const { font, codeFont } = fonts;
  verifyFonts(run, fonts);
  addReflowDiagnostics(run, font);
  const counts = representationCounts(run.blocks);
  const planHash = await contentHash(planHashInput(run, fonts));
  checkExportAbort(signal);
  const report: DocumentDocxReport = {
    schemaVersion: 1,
    exporterVersion: documentDocxExporterVersion,
    planHash,
    basis: clone(input.basis),
    styleProfileId: settings.styleProfileId,
    diagnostics: run.diagnostics,
    blocks: run.blocks,
    details: run.details,
    counts,
  };
  return register({
    report: deepFreeze(report),
    nodes: deepFreeze(run.nodes),
    numbering: deepFreeze(run.numbering),
    page: run.page,
    font,
    codeFont,
    assets: run.assets,
  });
}

async function invalidPlan(
  message: string,
  origin?: DocumentExportSnapshot['basis'],
): Promise<DocumentDocxPlan> {
  const basis = validExportBasis(origin as never)
    ? clone(origin!)
    : {
        kind: 'local-draft' as const,
        artifactId: 'invalid-input',
        contentHash: await contentHash(null),
      };
  const report: DocumentDocxReport = {
    schemaVersion: 1,
    exporterVersion: documentDocxExporterVersion,
    planHash: await contentHash({
      basis,
      code: 'INVALID_CONTENT',
      exporterVersion: documentDocxExporterVersion,
    }),
    basis,
    styleProfileId: 'document-ja-1',
    diagnostics: [exportDiagnostic<DocumentExportAddress>('INVALID_CONTENT', 'error', message)],
    blocks: [],
    details: [],
    counts: { native: 0, converted: 0, rasterized: 0 },
  };
  return register({
    report: deepFreeze(report),
    nodes: [],
    numbering: [],
    assets: new Map(),
    page: { width: 0, height: 0, margin: 0, landscape: false },
  });
}
