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

export async function prepareDocumentDocx(
  snapshot: DocumentExportSnapshot,
  options: DocumentDocxOptions,
  adapters: DocxAdapters,
  signal?: AbortSignal,
): Promise<DocumentDocxPlan> {
  checkExportAbort(signal);
  let input: DocumentExportSnapshot, settings: DocumentDocxOptions;
  try {
    input = deepFreeze(clone(snapshot));
    settings = deepFreeze(clone(options));
  } catch {
    return invalidPlan('Input must be serializable domain data');
  }
  const services = {
    resolveFont: adapters?.resolveFont?.bind(adapters),
    resolveAsset: adapters?.resolveAsset?.bind(adapters),
    imagePng: adapters?.imagePng?.bind(adapters),
    renderMermaid: adapters?.renderMermaid?.bind(adapters),
  };
  let valid = false;
  try {
    valid = isDocument(input?.content) && validExportBasis(input?.basis);
  } catch {
    /* Malformed native input is an addressed, non-waivable preflight failure. */
  }
  if (!valid) return invalidPlan('Invalid Document content or export basis', input?.basis);
  if (
    !settings ||
    typeof settings.fontProfileId !== 'string' ||
    !settings.fontProfileId ||
    settings.styleProfileId !== 'document-ja-1' ||
    !['reject', 'source', 'image'].includes(settings.mermaid) ||
    !['reject', 'source'].includes(settings.previewBlocks)
  )
    return invalidPlan('Invalid Document export options', input.basis);
  const content = input.content as DocumentContent;
  const diagnostics: ExportDiagnostic<DocumentExportAddress>[] = [];
  const ids = new Set<string>();
  const add = (
    code: string,
    severity: ExportDiagnostic['severity'],
    message: string,
    address?: DocumentExportAddress,
    effect?: ExportDiagnostic['effect'],
  ) => {
    const d = exportDiagnostic(code, severity, message, address, effect);
    if (!ids.has(d.id)) {
      diagnostics.push(d);
      ids.add(d.id);
    }
  };
  if (content.blocks.some((b) => b.reference))
    add(
      'REFERENCE_EXPORT_UNSUPPORTED',
      'error',
      '参照埋め込みのDOCX出力は未対応です。HTML／Markdownまたは参照付きnative JSONを使ってください。',
      { domain: 'document' },
    );
  if ((await contentHash(content)) !== input.basis.contentHash)
    add('SNAPSHOT_HASH_MISMATCH', 'error', 'Captured content does not match its declared hash');
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
  const pageSettings = content.page ?? { size: 'A4', margin: 64, landscape: false };
  const size = pageSettings.size === 'A4' ? [11906, 16838] : [12240, 15840];
  const page = {
    width: size[pageSettings.landscape ? 1 : 0],
    height: size[pageSettings.landscape ? 0 : 1],
    margin: Math.round(pageSettings.margin * 15),
    landscape: !!pageSettings.landscape,
  };
  if (pageSettings.landscape !== undefined && typeof pageSettings.landscape !== 'boolean')
    add('PAGE_SETTINGS_INVALID', 'error', 'Page orientation must be a boolean');
  const bodyWidth = (page.width - page.margin * 2) / 15;
  const bodyHeight = (page.height - page.margin * 2) / 15;
  const nodes: OwnedDocxPlan['nodes'] = [],
    assets: OwnedDocxPlan['assets'] = new Map();
  const numbering: OwnedDocxPlan['numbering'] = [];
  const blocks: DocumentDocxReport['blocks'] = [],
    details: DocumentDocxReport['details'] = [];
  let chars = 0,
    cells = 0,
    totalAssetBytes = 0,
    totalSourceBytes = 0,
    codeNeeded = false;
  const sourceHashes = new Set<string>();
  const checkText = (text: string, address: DocumentExportAddress) => {
    chars += text.length;
    let invalid = false;
    for (const char of text) {
      const code = char.codePointAt(0)!;
      if (
        (code < 32 && ![9, 10, 13].includes(code)) ||
        code === 0xfffe ||
        code === 0xffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        invalid = true;
        break;
      }
    }
    if (invalid)
      add(
        'TEXT_INVALID',
        'error',
        'Text contains characters that cannot be represented in Office XML',
        address,
      );
    if (chars > caps.textCharacters)
      add('LIMIT_EXCEEDED', 'error', 'At most 1,000,000 text characters can be exported', {
        domain: 'document',
      });
  };
  const rich = (spans: InlineSpan[], address: DocumentExportAddress, code = false): InlineSpan[] =>
    spans.map((s, i) => {
      const a = { ...address, path: `runs/${i}` },
        run = { ...s, ...(code ? { code: true } : {}) };
      checkText(run.text, address);
      if (run.code) codeNeeded = true;
      for (const key of ['color', 'highlight'] as const)
        if (run[key] !== undefined) {
          const c = exportColor(run[key]!);
          if (!c || c.alpha !== 1)
            add('COLOR_UNSUPPORTED', 'error', 'DOCX text colors must be opaque portable colors', a);
          else run[key] = '#' + c.hex;
        }
      if (run.link && !/^(https?:\/\/|mailto:)/i.test(run.link)) {
        add(
          'LINK_AS_TEXT',
          'warning',
          'This link becomes plain text; DOCX permits only HTTP, HTTPS and mailto links',
          a,
          'editability',
        );
        delete run.link;
      }
      return run;
    });
  const paragraph = (
    spans: InlineSpan[],
    address: DocumentExportAddress,
    block: Pick<DocumentBlock, 'align' | 'indent' | 'style'> = {},
    role: DocxParagraph['role'] = 'body',
  ): DocxParagraph => {
    details.push({ address, kind: 'paragraph', outputPartNames: [] });
    if (block.style?.fontFamily === 'Noto Sans Mono CJK JP') codeNeeded = true;
    if (block.style?.fontSize !== undefined && !Number.isInteger(block.style.fontSize * 2))
      add(
        'STYLE_SIZE_QUANTIZED',
        'warning',
        'DOCX uses half-point font sizes; this style is rounded to the nearest half point',
        address,
        'appearance',
      );
    if ((block.indent ?? 0) * 24 >= bodyWidth)
      add('INDENT_EXCEEDS_BODY', 'error', 'Paragraph indentation leaves no body width', address);
    return {
      kind: 'paragraph',
      address,
      runs: rich(spans, address, role === 'code'),
      ...(block.style ? { style: { ...block.style } } : {}),
      align: block.align,
      indent: (block.indent ?? 0) * 24,
      role,
    };
  };
  const assetSources = new Map<string, string>();
  const ownAsset = async (value: ExportAsset, address: DocumentExportAddress): Promise<string> => {
    let asset = ownExportAsset(value);
    const sourceHash = await hashExportBytes(asset.bytes);
    if (!sourceHashes.has(sourceHash)) {
      sourceHashes.add(sourceHash);
      totalSourceBytes += asset.bytes.length;
      if (totalSourceBytes > exportAssetLimits.totalBytes)
        throw Error('Total resolved images exceed 64 MiB');
    }
    if (asset.mime === 'image/gif' || asset.mime === 'image/webp') {
      add(
        'IMAGE_STATIC_PNG',
        'warning',
        'GIF/WebP becomes a static PNG picture',
        address,
        'appearance',
      );
      if (!services.imagePng) throw Error('A static image conversion adapter is required');
      asset = ownExportAsset(await services.imagePng(ownExportAsset(asset), signal));
      checkExportAbort(signal);
      if (asset.mime !== 'image/png') throw Error('The image conversion did not return a PNG');
    }
    const hash = await hashExportBytes(asset.bytes);
    const key = asset.mime + '/' + hash;
    if (!assets.has(key)) {
      totalAssetBytes += asset.bytes.length;
      if (totalAssetBytes > exportAssetLimits.totalBytes)
        throw Error('Total image bytes exceed 64 MiB');
      assets.set(key, { ...asset, hash });
    }
    return key;
  };
  const addPicture = (key: string, block: DocumentBlock, address: DocumentExportAddress) => {
    const asset = assets.get(key)!;
    const requested = block.width ?? asset.width;
    const availableWidth = bodyWidth - (block.indent ?? 0) * 24;
    const scale = Math.min(
      requested / asset.width,
      availableWidth / asset.width,
      bodyHeight / asset.height,
    );
    if (scale <= 0) {
      add('IMAGE_SIZE_INVALID', 'error', 'Image has no available body area', address);
      return;
    }
    if (scale < requested / asset.width)
      add(
        'IMAGE_SCALED_TO_BODY',
        'warning',
        'Image is proportionally reduced to fit the page body',
        address,
        'appearance',
      );
    const alt = block.alt ?? '';
    if (typeof alt !== 'string') {
      add('IMAGE_ALT_INVALID', 'error', 'Image alt text must be a string', address);
      return;
    }
    checkText(alt, address);
    nodes.push({
      kind: 'image',
      address,
      assetKey: key,
      width: asset.width * scale,
      height: asset.height * scale,
      alt,
    });
    details.push({ address, kind: 'image', outputPartNames: [] });
    if (block.caption)
      nodes.push(
        paragraph([{ text: block.caption }], { ...address, path: 'caption' }, {}, 'caption'),
      );
  };
  const list = (
    items: DocumentListItem[],
    kind: 'bullet' | 'number' | 'check',
    block: DocumentBlock,
    level: number,
    start = 1,
  ) => {
    const address: DocumentExportAddress = { domain: 'document', blockId: block.id };
    if (level > caps.maxListLevel) {
      add('LIST_DEPTH_EXCEEDED', 'error', 'Lists support levels 0 through 8', address);
      return;
    }
    const reference = `list${numbering.length + 1}`;
    if (kind !== 'check')
      numbering.push({ reference, kind, level, ...(start !== 1 ? { start } : {}) });
    else
      add(
        'CHECKBOX_STATIC',
        'warning',
        'Checked states become static [x] / [ ] text',
        address,
        'editability',
      );
    for (const item of items) {
      const p = paragraph(item.rich, { ...address, itemId: item.id }, block);
      if (kind === 'check') {
        p.runs.unshift({ text: item.checked ? '[x] ' : '[ ] ' });
        p.indent += (level + 1) * 24;
      } else p.numbering = { reference, level };
      nodes.push(p);
      for (const nested of nestedLists(item))
        list(
          nested.items,
          (nested.check ?? kind === 'check')
            ? 'check'
            : nested.type === 'ordered_list'
              ? 'number'
              : 'bullet',
          block,
          level + 1,
          nested.start,
        );
    }
  };
  // Keep pathological limits from invoking asset/font adapters. Validation never truncates success.
  if (content.blocks.length <= caps.blocks)
    for (const [blockIndex, block] of content.blocks.entries()) {
      if (block.hidden) continue;
      checkExportAbort(signal);
      if (blockIndex % 32 === 31) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const address: DocumentExportAddress = { domain: 'document', blockId: block.id };
      let representation: DocxRepresentation = 'native';
      if (
        ['caption', 'alt', 'language'].some((k) => {
          const v = block[k as 'caption'];
          return v !== undefined && typeof v !== 'string';
        })
      ) {
        add('INVALID_CONTENT', 'error', 'Caption, alt text and language must be strings', address);
        continue;
      }
      if (block.type === 'heading' || block.type === 'paragraph') {
        const p = paragraph(block.rich ?? [{ text: block.text }], address, block);
        if (block.type === 'heading') p.heading = block.level ?? 1;
        nodes.push(p);
      } else if (['bulleted-list', 'numbered-list', 'check-list'].includes(block.type)) {
        const kind =
          block.type === 'check-list'
            ? 'check'
            : block.type === 'numbered-list'
              ? 'number'
              : 'bullet';
        list(
          block.items ??
            block.text
              .split('\n')
              .map((text, i) => ({ id: `${block.id}:item:${i}`, rich: [{ text }] })),
          kind,
          block,
          0,
          block.start,
        );
        if (
          kind === 'check' ||
          diagnostics.some((d) => d.code === 'CHECKBOX_STATIC' && d.address?.blockId === block.id)
        )
          representation = 'static-checkbox';
      } else if (block.type === 'table') {
        const source = block.cells!,
          cols = source[0].length;
        cells += source.length * cols;
        if (cells > caps.logicalCells) {
          add(
            'TABLE_LIMIT_EXCEEDED',
            'error',
            'At most 50,000 logical table cells can be exported',
            address,
          );
          continue;
        }
        const widths = block.columnWidths
          ? [...block.columnWidths]
          : Array<number>(cols).fill(bodyWidth / cols);
        const sum = widths.reduce((a, b) => a + b, 0);
        if (sum > bodyWidth) {
          widths.forEach((w, i) => (widths[i] = (w * bodyWidth) / sum));
          add(
            'TABLE_SCALED_TO_BODY',
            'warning',
            'Table columns are proportionally reduced to the body width',
            address,
            'appearance',
          );
        }
        const table: DocxTable = { kind: 'table', address, widths, rows: [] };
        const merges = new Map<string, NonNullable<DocumentBlock['merges']>[number]>();
        for (const m of block.merges ?? [])
          for (let r = m.row; r < m.row + m.rows; r++)
            for (let c = m.col; c < m.col + m.cols; c++) merges.set(`${r}:${c}`, m);
        let repeating = true;
        source.forEach((row, r) => {
          // Do not infer a repeated header from first-row position in legacy content.
          repeating =
            repeating &&
            !!block.cellHeaders?.[r] &&
            block.cellHeaders[r].length === cols &&
            block.cellHeaders[r].every((v) => v === true);
          const outputRow: DocxTable['rows'][number] = { header: repeating, cells: [] };
          row.forEach((text, c) => {
            const merge = merges.get(`${r}:${c}`);
            if (merge && c !== merge.col) return;
            const continuation = !!merge && r > merge.row;
            const a = { ...address, cell: { row: r, column: c } };
            const parts = continuation
              ? []
              : (block.cellParagraphs?.[r]?.[c] ?? [
                  { id: '', rich: block.cellRich?.[r]?.[c] ?? [{ text }] },
                ]);
            const paragraphs = parts.map((part, p) => paragraph(part.rich, { ...a, paragraph: p }));
            const header = block.cellHeaders?.[r]?.[c] ?? r === 0;
            outputRow.cells.push({
              address: a,
              column: c,
              columns: merge?.cols ?? 1,
              merge: merge && merge.rows > 1 ? (continuation ? 'continue' : 'restart') : undefined,
              paragraphs,
              header,
            });
            if (!continuation) details.push({ address: a, kind: 'cell', outputPartNames: [] });
          });
          table.rows.push(outputRow);
        });
        nodes.push(table);
      } else if (block.type === 'image') {
        try {
          if (!block.src || !services.resolveAsset)
            throw Error('An image source and resolver are required');
          let key = assetSources.get(block.src);
          if (!key) {
            key = await ownAsset(await services.resolveAsset(block.src, signal), address);
            assetSources.set(block.src, key);
          }
          checkExportAbort(signal);
          addPicture(key, block, address);
        } catch {
          checkExportAbort(signal);
          add(
            'ASSET_FAILED',
            'error',
            'Image could not be resolved, decoded or kept within the declared limits',
            address,
          );
        }
      } else if (block.type === 'mermaid' && settings.mermaid === 'image') {
        representation = 'png';
        checkText(block.text, address);
        if (chars > caps.textCharacters) continue;
        add(
          'MERMAID_RASTERIZED',
          'warning',
          'The Mermaid diagram becomes a picture',
          address,
          'editability',
        );
        try {
          if (!services.renderMermaid) throw Error('A Mermaid renderer is required');
          const key = await ownAsset(await services.renderMermaid(block.text, signal), address);
          checkExportAbort(signal);
          if (assets.get(key)!.mime !== 'image/png')
            throw Error('Mermaid rendering must return PNG');
          addPicture(key, { ...block, alt: block.alt ?? 'Mermaid diagram' }, address);
        } catch {
          checkExportAbort(signal);
          add('MERMAID_FAILED', 'error', 'Mermaid syntax or rendering failed', address);
        }
      } else if (
        block.type === 'code' ||
        (block.type === 'mermaid' && settings.mermaid === 'source') ||
        (['html', 'react-preview'].includes(block.type) && settings.previewBlocks === 'source')
      ) {
        if (block.type !== 'code') {
          representation = 'source';
          add(
            block.type === 'mermaid' ? 'MERMAID_AS_SOURCE' : 'PREVIEW_AS_SOURCE',
            'warning',
            'The block becomes escaped source text; preview code is never executed',
            address,
            'appearance',
          );
        }
        const label = block.type === 'code' ? block.language : block.type;
        if (label)
          nodes.push(paragraph([{ text: label }], { ...address, path: 'language' }, {}, 'caption'));
        nodes.push(paragraph([{ text: block.text }], address, block, 'code'));
      } else
        add(
          'BLOCK_UNSUPPORTED',
          'error',
          'Select an explicit image/source policy for this block',
          address,
        );
      blocks.push({ address, representation, outputPartNames: [] });
    }
  let font: ExportFontProfile | undefined, codeFont: ExportFontProfile | undefined;
  const loadFont = async (id: string) => {
    try {
      if (!services.resolveFont) throw Error('Missing font resolver');
      const f = deepFreeze(clone(await services.resolveFont(id, signal)));
      checkExportAbort(signal);
      if (!validFontProfile(f, id)) throw Error('Invalid font profile');
      if (!f.verified)
        add(
          'FONT_UNVERIFIED',
          'warning',
          `Font ${f.family} ${f.version} was not verified`,
          { domain: 'document', path: `font/${id}` },
          'appearance',
        );
      return f;
    } catch {
      checkExportAbort(signal);
      add('FONT_INVALID', 'error', 'A complete matching font profile is required', {
        domain: 'document',
        path: `font/${id}`,
      });
    }
  };
  if (!diagnostics.some((d) => d.severity === 'error')) {
    font = await loadFont(settings.fontProfileId);
    if (codeNeeded) codeFont = await loadFont(caps.codeFontProfileId);
  }
  const verifyParagraph = (p: DocxParagraph) => {
    if (p.style?.fontFamily) {
      const selected = p.style.fontFamily === 'Noto Sans Mono CJK JP' ? codeFont : font;
      if (selected && selected.family !== p.style.fontFamily)
        add(
          'STYLE_FONT_UNAVAILABLE',
          'error',
          'The resolved font profile does not match the named style font',
          p.address,
        );
    }
    for (const run of p.runs) {
      const f = run.code || p.style?.fontFamily === 'Noto Sans Mono CJK JP' ? codeFont : font;
      if (f && missingFontGlyphs(run.text, f).length)
        add(
          'GLYPH_MISSING',
          'error',
          'The selected font lacks one or more required glyphs',
          p.address,
        );
    }
  };
  if (font && numbering.some((n) => n.kind === 'bullet') && missingFontGlyphs('•', font).length)
    add('GLYPH_MISSING', 'error', 'The selected font lacks the list bullet glyph');
  for (const n of nodes) {
    if (n.kind === 'paragraph') verifyParagraph(n);
    else if (n.kind === 'table')
      for (const r of n.rows) for (const c of r.cells) c.paragraphs.forEach(verifyParagraph);
  }
  add(
    'DOCX_REFLOW_EXPECTED',
    'info',
    'Office reflows this document; line breaks and page count can differ from the Editor',
  );
  add(
    'FONT_NOT_EMBEDDED',
    'info',
    `Recipients need ${font?.family ?? settings.fontProfileId}${codeNeeded ? ' and Noto Sans Mono CJK JP' : ''}; fonts are referenced, not embedded`,
  );
  const counts = { native: 0, converted: 0, rasterized: 0 };
  for (const b of blocks)
    counts[
      b.representation === 'native'
        ? 'native'
        : b.representation === 'png'
          ? 'rasterized'
          : 'converted'
    ]++;
  const planHash = await contentHash({
    exporterVersion: documentDocxExporterVersion,
    basis: input.basis,
    options: settings,
    font,
    codeFont,
    page,
    nodes,
    numbering,
    assets: [...assets].map(([key, a]) => ({
      key,
      hash: a.hash,
      mime: a.mime,
      width: a.width,
      height: a.height,
    })),
    diagnostics: diagnostics.map(({ id, code, severity, effect, requiresAcceptance }) => ({
      id,
      code,
      severity,
      effect,
      requiresAcceptance,
    })),
  });
  checkExportAbort(signal);
  const report: DocumentDocxReport = {
    schemaVersion: 1,
    exporterVersion: documentDocxExporterVersion,
    planHash,
    basis: clone(input.basis),
    styleProfileId: settings.styleProfileId,
    diagnostics,
    blocks,
    details,
    counts,
  };
  return register({
    report: deepFreeze(report),
    nodes: deepFreeze(nodes),
    numbering: deepFreeze(numbering),
    page,
    font,
    codeFont,
    assets,
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
