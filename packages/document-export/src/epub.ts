import { clone, contentHash, deepFreeze } from '@editor-platform/artifact-core';
import {
  composeDocumentSequence,
  type DocumentSequenceSource,
  type DocumentSequenceManifest,
} from '@editor-platform/document/sequence';
import {
  documentStyleCss,
  isVerticalDocument,
  rubyGroups,
  emphasisDotsCss,
  safeLink,
  uprightDigitRanges,
  type DocumentBlock,
  type DocumentContent,
  type InlineSpan,
} from '@editor-platform/document/model';
import {
  acceptsExport,
  checkExportAbort,
  exportDiagnostic,
  type ExportReport,
  type ExportConsent,
  type ExportResult,
  type ReadonlyTree,
  type DocumentExportAddress,
} from '@editor-platform/export-core';
import { strToU8, zipSync, type Zippable } from 'fflate';

export interface DocumentEpubMetadata {
  title: string;
  language: string;
  identifier: string;
  creators: string[];
  /** Exact publication modification time, UTC with second precision. */
  modified: string;
}
export interface DocumentEpubReport extends ExportReport<DocumentExportAddress> {
  format: 'epub3-horizontal' | 'epub3-vertical';
  metadata: DocumentEpubMetadata;
  sources: DocumentSequenceManifest;
  chapters: {
    sourceIndex: number;
    path: string;
    title: string;
    /** Each chapter keeps its own exact version's writing mode. */
    writingMode: 'vertical-rl' | 'horizontal-tb';
    elements: { sourceId: string; derivedId: string; xhtmlId: string }[];
  }[];
  /** Packaged images and fonts, by path, with the SHA-256 of their bytes. */
  resources: { path: string; mediaType: string; sha256: string; bytes: number }[];
}
declare const epubBrand: unique symbol;
export interface DocumentEpubPlan {
  readonly [epubBrand]: true;
  readonly report: ReadonlyTree<DocumentEpubReport>;
}
type EpubFiles = Record<string, string | Uint8Array>;
const plans = new WeakMap<
  DocumentEpubPlan,
  { report: ReadonlyTree<DocumentEpubReport>; files: EpubFiles }
>();
export const documentEpubLimits = Object.freeze({
  bytes: 16 * 1024 * 1024,
  creators: 16,
  fonts: 8,
});
export const documentEpubExporterVersion = 'epub-horizontal/1.1.0';
export const documentEpubVerticalExporterVersion = 'epub-vertical/1.1.0';
/** A font file the Host chooses to embed, for example a subset it is licensed to distribute.
 * The exporter never fetches or subsets fonts. */
export interface DocumentEpubFont {
  family: string;
  format: 'otf' | 'ttf' | 'woff' | 'woff2';
  data: Uint8Array;
  weight?: 400 | 700;
}
export interface DocumentEpubOptions {
  /** Embedded in order; the first is the reading font of the body text. */
  fonts?: readonly DocumentEpubFont[];
}
const fontMedia = {
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
} as const;
const fontMagic = (data: Uint8Array) => {
  const tag = String.fromCharCode(...data.slice(0, 4));
  return tag === 'OTTO'
    ? 'otf'
    : tag === 'wOFF'
      ? 'woff'
      : tag === 'wOF2'
        ? 'woff2'
        : tag === 'true' || (data[0] === 0 && data[1] === 1 && data[2] === 0 && data[3] === 0)
          ? 'ttf'
          : undefined;
};
const imageMedia: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};
/** Decodes an embedded `data:` image. EPUB export never fetches a remote image. */
function dataImage(src: string): { media: string; ext: string; data: Uint8Array } | undefined {
  const match = /^data:([a-z+/.-]+)(;base64)?,(.*)$/is.exec(src);
  if (!match) return;
  const media = match[1].toLowerCase(),
    ext = imageMedia[media];
  if (!ext) return;
  try {
    if (match[2]) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(match[3]) || match[3].length % 4) return;
      const binary = atob(match[3]);
      if (!binary.length) return;
      return { media, ext, data: Uint8Array.from(binary, (c) => c.charCodeAt(0)) };
    }
    const text = decodeURIComponent(match[3]);
    return text ? { media, ext, data: strToU8(text) } : undefined;
  } catch {
    return;
  }
}
const byteLength = (value: string | Uint8Array) =>
  typeof value === 'string' ? strToU8(value).length : value.length;
const sha256 = async (data: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const xmlText = (value: string) =>
  [...value].every((char) => {
    const n = char.codePointAt(0)!;
    return (
      n === 9 ||
      n === 10 ||
      n === 13 ||
      (n >= 32 && n <= 0xd7ff) ||
      (n >= 0xe000 && n <= 0xfffd) ||
      (n >= 0x10000 && n <= 0x10ffff)
    );
  });
const xml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
function ownMetadata(raw: DocumentEpubMetadata): DocumentEpubMetadata | undefined {
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
    Object.getOwnPropertySymbols(raw).length
  )
    return;
  const keys = ['title', 'language', 'identifier', 'creators', 'modified'];
  const fields = Object.getOwnPropertyDescriptors(raw);
  if (
    Object.keys(fields).length !== keys.length ||
    keys.some((k) => !fields[k]?.enumerable || !('value' in fields[k]))
  )
    return;
  const value = Object.fromEntries(
    keys.map((k) => [k, fields[k].value]),
  ) as unknown as DocumentEpubMetadata;
  const text = (v: unknown, limit: number): v is string =>
    typeof v === 'string' && !!v.trim() && v.length <= limit && xmlText(v);
  if (
    !Array.isArray(value.creators) ||
    Object.getPrototypeOf(value.creators) !== Array.prototype ||
    value.creators.length > documentEpubLimits.creators ||
    Object.getOwnPropertySymbols(value.creators).length
  )
    return;
  const creatorFields = Object.getOwnPropertyDescriptors(value.creators);
  if (Object.keys(creatorFields).length !== value.creators.length + 1) return;
  const creators: string[] = [];
  for (let i = 0; i < value.creators.length; i++) {
    const field = creatorFields[String(i)];
    if (!field?.enumerable || !('value' in field) || !text(field.value, 160)) return;
    creators.push(field.value);
  }
  if (
    !text(value.title, 512) ||
    !text(value.identifier, 512) ||
    !text(value.language, 64) ||
    !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(value.language) ||
    typeof value.modified !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.modified) ||
    !Number.isFinite(Date.parse(value.modified)) ||
    new Date(value.modified).toISOString() !== value.modified.replace('Z', '.000Z')
  )
    return;
  try {
    Intl.getCanonicalLocales(value.language);
  } catch {
    return;
  }
  value.creators = creators;
  return clone(value);
}
/** `upright` holds 縦中横 ranges within this span; runs crossing spans stay in the text
 * direction, as in the editor. */
function inline(
  span: InlineSpan,
  upright: [number, number][] = [],
  link?: (href: string) => string | undefined,
) {
  let result = '',
    at = 0;
  for (const [start, end] of upright) {
    result +=
      xml(span.text.slice(at, start)) +
      `<span class="tcy">${xml(span.text.slice(start, end))}</span>`;
    at = end;
  }
  result = (result + xml(span.text.slice(at))).replace(/\n/g, '<br/>');
  if (span.code) result = `<code>${result}</code>`;
  if (span.bold) result = `<strong>${result}</strong>`;
  if (span.italic) result = `<em>${result}</em>`;
  if (span.strike) result = `<s>${result}</s>`;
  const css = [
    span.bold === false ? 'font-weight:400' : '',
    // Older EPUB readers know 傍点 only under the -epub- prefix.
    span.emphasisDots
      ? `-epub-text-emphasis-style:filled sesame;${span.ruby ? '-epub-text-emphasis-position:under left;' : ''}${emphasisDotsCss(!!span.ruby)}`
      : '',
    span.underline ? 'text-decoration:underline' : '',
    span.color ? `color:${span.color}` : '',
    span.highlight ? `background-color:${span.highlight}` : '',
  ]
    .filter(Boolean)
    .join(';');
  if (css) result = `<span style="${xml(css)}">${result}</span>`;
  const href = span.link && link?.(span.link);
  return href ? `<a href="${xml(href)}">${result}</a>` : result;
}
function inlines(
  spans: InlineSpan[],
  vertical: boolean,
  link?: (href: string) => string | undefined,
) {
  const text = spans.map((s) => s.text).join('');
  const ranges = vertical ? uprightDigitRanges(text) : [];
  const starts: number[] = [];
  spans.reduce((offset, span) => (starts.push(offset), offset + span.text.length), 0);
  // Ranges and spans are both in text order, so one pass assigns each range to its span.
  let next = 0;
  const html = spans.map((span, i) => {
    const end = starts[i] + span.text.length;
    const own: [number, number][] = [];
    while (next < ranges.length && ranges[next][0] < end) {
      const [a, b] = ranges[next++];
      // A run crossing into the next span stays in the text direction, as in the editor.
      if (b <= end) own.push([a - starts[i], b - starts[i]]);
    }
    return inline(span, own, link);
  });
  return rubyGroups(spans)
    .map(({ spans: group, start, ruby }) => {
      const inner = html.slice(start, start + group.length).join('');
      return ruby ? `<ruby>${inner}<rt>${xml(ruby.text)}</rt></ruby>` : inner;
    })
    .join('');
}
const xhtml = (title: string, language: string, body: string, mode?: 'vertical' | 'horizontal') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(language)}" lang="${xml(language)}"${mode ? ` class="${mode}"` : ''}><head><meta charset="UTF-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;

function figureHtml(block: DocumentBlock, id: string, style: string, path: string) {
  const width = block.width ? ` width="${Math.round(block.width)}"` : '';
  const caption = block.caption ? `<figcaption>${xml(block.caption)}</figcaption>` : '';
  return `<figure id="${id}"${style}><img src="${xml(path)}" alt="${xml(block.alt ?? '')}"${width}/>${caption}</figure>`;
}
/** Exact chapter versions are captured before the first await. Output is a derived local
 * projection; the report's basis is not a new saved Artifact or an invented version. */
export async function prepareDocumentEpub(
  input: readonly DocumentSequenceSource[],
  metadata: DocumentEpubMetadata,
  signal?: AbortSignal,
  options: DocumentEpubOptions = {},
): Promise<DocumentEpubPlan> {
  checkExportAbort(signal);
  const sources = clone(input),
    settings = ownMetadata(metadata);
  // Font bytes are copied before the first await, as chapter versions are.
  const fontInput = Array.isArray(options.fonts) ? options.fonts : [];
  const fonts = fontInput.slice(0, documentEpubLimits.fonts + 1).map((f) => ({
    family: typeof f?.family === 'string' ? f.family : '',
    format: f?.format as DocumentEpubFont['format'],
    weight: f?.weight,
    data: f?.data instanceof Uint8Array ? f.data.slice() : undefined,
  }));
  const sequence = await composeDocumentSequence(sources);
  checkExportAbort(signal);
  const content: DocumentContent = sequence.content ?? { schemaVersion: 2, blocks: [] };
  const basis = {
    kind: 'local-draft' as const,
    artifactId: 'derived-document-sequence',
    contentHash: await contentHash(content),
  };
  const diagnostics: DocumentEpubReport['diagnostics'] = sequence.manifest.diagnostics.map((d) =>
    exportDiagnostic('SEQUENCE_' + d.code.toUpperCase().replace(/-/g, '_'), d.severity, d.message, {
      domain: 'document',
      ...(d.elementId ? { blockId: d.elementId } : {}),
      ...(d.sourceIndex === undefined ? {} : { path: `sources/${d.sourceIndex}` }),
    }),
  );
  const add = (code: string, severity: 'error' | 'warning', message: string, blockId?: string) =>
    diagnostics.push(
      exportDiagnostic(
        code,
        severity,
        message,
        { domain: 'document', ...(blockId ? { blockId } : {}) },
        severity === 'error' ? 'blocked' : 'appearance',
      ),
    );
  if (!settings)
    add(
      'INVALID_METADATA',
      'error',
      'Supply bounded XML-safe title/language/identifier/creators and an exact UTC modified time; unknown metadata is unsupported',
    );
  // Composition keeps only the first chapter's page settings, so check every exact source.
  const modes = sources.map(({ artifact, versionId }) => {
    const version = artifact.versions.find((v) => v.versionId === versionId);
    return version ? isVerticalDocument(version.content) : undefined;
  });
  // The book's page progression follows the first chapter; each chapter keeps its own mode.
  const vertical = modes[0] ?? isVerticalDocument(content);
  const mixed = modes.includes(true) && modes.includes(false);
  if (mixed)
    add(
      'MIXED_WRITING_MODE',
      'warning',
      `Chapters keep their own writing mode (vertical and horizontal mixed); the page progression follows the first chapter (${vertical ? 'right to left' : 'left to right'}). Some readers apply one writing mode to the whole book.`,
    );
  if (fonts.length > documentEpubLimits.fonts)
    add('INVALID_FONT', 'error', `Embed at most ${documentEpubLimits.fonts} fonts`);
  fonts.slice(0, documentEpubLimits.fonts).forEach((font, i) => {
    if (
      !font.family.trim() ||
      font.family.length > 128 ||
      !xmlText(font.family) ||
      /["\\<>;{}]/.test(font.family) ||
      !font.data ||
      !(font.format in fontMedia) ||
      fontMagic(font.data) !== font.format ||
      (font.weight !== undefined && font.weight !== 400 && font.weight !== 700)
    )
      add(
        'INVALID_FONT',
        'error',
        `Font ${i + 1} needs a plain family name and OpenType, TrueType, WOFF or WOFF2 bytes matching its format`,
      );
  });
  const embedded = new Set(fonts.map((f) => f.family));
  const usedFamilies = new Set(
    content.blocks.flatMap((b) => (b.style?.fontFamily ? [b.style.fontFamily] : [])),
  );
  for (const family of usedFamilies)
    if (!embedded.has(family))
      add(
        'FONT_NOT_EMBEDDED',
        'warning',
        `${family} is not embedded; readers substitute their own font for it`,
      );
  add(
    'REFLOW_FONT_DIFFERENCE',
    'warning',
    vertical
      ? 'Vertical reflowable EPUB uses reader fonts and line breaking. Page settings, native fonts, the manuscript grid and fixed pagination are not preserved; only one or two ASCII digits are set upright.'
      : 'Horizontal reflowable EPUB uses reader fonts. Page settings, native fonts, line breaks and fixed pagination are not preserved.',
  );
  // In-book links name a source block id; the same chapter's block wins, then any chapter's.
  const chapterPath = (order: number) => `chapter-${String(order + 1).padStart(3, '0')}.xhtml`;
  const hiddenIds = new Set(content.blocks.filter((b) => b.hidden).map((b) => b.id));
  const anchors = new Map<string, string>();
  const bySource = new Map<string, string>();
  for (const source of sequence.manifest.sources)
    for (const [index, mapping] of source.elements.entries()) {
      if (hiddenIds.has(mapping.outputId)) continue;
      const anchor = `${chapterPath(source.order)}#block-${index + 1}`;
      anchors.set(mapping.outputId, anchor);
      if (!bySource.has(mapping.sourceId)) bySource.set(mapping.sourceId, anchor);
    }
  const linkTarget = (href: string, blockId: string) => {
    if (!href.startsWith('#')) return href;
    const id = href.slice(1);
    const prefix = /^sequence:\d+:/.exec(blockId)?.[0] ?? '';
    return anchors.get(prefix + id) ?? bySource.get(id);
  };
  for (const block of content.blocks) {
    if (block.type === 'image' && !block.hidden && !(block.src && dataImage(block.src)))
      add(
        'IMAGE_SOURCE_UNSUPPORTED',
        'error',
        'EPUB packages embedded PNG, JPEG, GIF, WebP or SVG images only and never fetches; embed the image in the Document first',
        block.id,
      );
    if (
      (block.alt !== undefined && !xmlText(block.alt)) ||
      (block.caption !== undefined && !xmlText(block.caption))
    )
      add(
        'INVALID_XML_TEXT',
        'error',
        'Image text contains characters not representable in XML 1.0',
        block.id,
      );
    if (
      !xmlText(block.text) ||
      block.rich?.some((s) => !xmlText(s.text) || (s.ruby && !xmlText(s.ruby.text)))
    )
      add(
        'INVALID_XML_TEXT',
        'error',
        'Text contains characters not representable in XML 1.0',
        block.id,
      );
    for (const span of block.rich ?? [])
      if (span.link && (!safeLink(span.link) || !xmlText(span.link)))
        add(
          'LINK_UNSUPPORTED',
          'error',
          'Only http, https, mailto and in-book links are kept',
          block.id,
        );
      else if (span.link?.startsWith('#') && !linkTarget(span.link, block.id))
        add(
          'LINK_TARGET_MISSING',
          'warning',
          `In-book link ${span.link} has no target in the exported chapters; it is kept as plain text`,
          block.id,
        );
    if (block.hidden)
      add(
        'HIDDEN_OMITTED',
        'warning',
        'Hidden native block is omitted from EPUB reading content',
        block.id,
      );
  }
  const book = settings ?? { title: '', language: '', identifier: '', creators: [], modified: '' };
  const chapters: DocumentEpubReport['chapters'] = [];
  const files: EpubFiles = {};
  const resources: DocumentEpubReport['resources'] = [];
  if (!diagnostics.some((d) => d.severity === 'error')) {
    const images = new Map<string, string>();
    const imagePath = async (src: string) => {
      const known = images.get(src);
      if (known) return known;
      const image = dataImage(src)!;
      const path = `images/image-${images.size + 1}.${image.ext}`;
      images.set(src, path);
      files['EPUB/' + path] = image.data;
      resources.push({
        path: 'EPUB/' + path,
        mediaType: image.media,
        sha256: await sha256(image.data),
        bytes: image.data.length,
      });
      return path;
    };
    const fontFaces: string[] = [];
    for (const [i, font] of fonts.entries()) {
      const path = `fonts/font-${i + 1}.${font.format}`;
      files['EPUB/' + path] = font.data!;
      resources.push({
        path: 'EPUB/' + path,
        mediaType: fontMedia[font.format],
        sha256: await sha256(font.data!),
        bytes: font.data!.length,
      });
      fontFaces.push(
        `@font-face { font-family: "${font.family}"; src: url("${path}") format("${font.format === 'ttf' ? 'truetype' : font.format === 'otf' ? 'opentype' : font.format}"); font-weight: ${font.weight ?? 400}; }`,
      );
    }
    const readingFont = fonts[0] ? `"${fonts[0].family}", ` : '';
    const byId = new Map(content.blocks.map((b) => [b.id, b]));
    for (const source of sequence.manifest.sources) {
      checkExportAbort(signal);
      const title = sources[source.order].artifact.name;
      if (typeof title !== 'string' || !title.trim() || title.length > 512 || !xmlText(title)) {
        add(
          'INVALID_CHAPTER_TITLE',
          'error',
          'Artifact title cannot be represented in EPUB metadata',
        );
        continue;
      }
      const path = chapterPath(source.order);
      const chapterVertical = modes[source.order] ?? vertical;
      const elements: DocumentEpubReport['chapters'][number]['elements'] = [];
      const paragraphs: string[] = [];
      for (const [index, mapping] of source.elements.entries()) {
        const block = byId.get(mapping.outputId)!;
        if (block.hidden) continue;
        const id = `block-${index + 1}`;
        elements.push({ sourceId: mapping.sourceId, derivedId: mapping.outputId, xhtmlId: id });
        const css =
          (documentStyleCss(block.style) ? documentStyleCss(block.style) + ';' : '') +
          (block.align ? `text-align:${block.align};` : '') +
          (block.indent
            ? `${chapterVertical ? 'margin-top' : 'margin-left'}:${block.indent * 1.5}em;`
            : '');
        const style = css ? ` style="${xml(css)}"` : '';
        if (block.type === 'image') {
          paragraphs.push(figureHtml(block, id, style, await imagePath(block.src!)));
          continue;
        }
        const tag = block.type === 'heading' ? `h${block.level ?? 1}` : 'p';
        paragraphs.push(
          `<${tag} id="${id}"${style}>${inlines(block.rich ?? [{ text: block.text }], chapterVertical, (href) => linkTarget(href, block.id))}</${tag}>`,
        );
      }
      chapters.push({
        sourceIndex: source.order,
        path: 'EPUB/' + path,
        title,
        writingMode: chapterVertical ? 'vertical-rl' : 'horizontal-tb',
        elements,
      });
      files['EPUB/' + path] = xhtml(
        title,
        book.language,
        paragraphs.join('\n'),
        chapterVertical ? 'vertical' : 'horizontal',
      );
    }
    files['EPUB/style.css'] = [
      ...fontFaces,
      'html.vertical { writing-mode: vertical-rl; -webkit-writing-mode: vertical-rl; -epub-writing-mode: vertical-rl; }',
      `html.vertical body { font-family: ${readingFont}serif-ja, serif; line-height: 1.8; line-break: strict; -webkit-line-break: strict; }`,
      'html.horizontal, html:not([class]) { writing-mode: horizontal-tb; }',
      `html.horizontal body, html:not([class]) body { font-family: ${readingFont}serif; line-height: 1.6; }`,
      'p,h1,h2,h3,h4,h5,h6 { white-space: pre-wrap; } rt { font-size: 50%; } .tcy { text-combine-upright: all; -webkit-text-combine: horizontal; -epub-text-combine: horizontal; }',
      'figure { margin: 1em 0; text-align: center; } figure img { max-width: 100%; max-height: 95vh; } html.vertical figure img { max-height: 100%; max-width: 95vw; }',
    ].join('\n');
    files['EPUB/nav.xhtml'] = xhtml(
      'Contents',
      book.language,
      `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${chapters.map((c) => `<li><a href="${c.path.slice(5)}">${xml(c.title)}</a></li>`).join('')}</ol></nav>`,
    );
    files['META-INF/container.xml'] =
      '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
    files['EPUB/package.opf'] =
      `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${xml(book.identifier)}</dc:identifier><dc:title>${xml(book.title)}</dc:title><dc:language>${xml(book.language)}</dc:language>${book.creators.map((c) => `<dc:creator>${xml(c)}</dc:creator>`).join('')}<meta property="dcterms:modified">${book.modified}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="style.css" media-type="text/css"/><item id="sources" href="sources.json" media-type="application/json"/><item id="report" href="export-report.json" media-type="application/json"/>${resources.map((r, i) => `<item id="resource-${i + 1}" href="${r.path.slice(5)}" media-type="${r.mediaType}"/>`).join('')}${chapters.map((c, i) => `<item id="chapter-${i + 1}" href="${c.path.slice(5)}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine page-progression-direction="${vertical ? 'rtl' : 'ltr'}">${chapters.map((_, i) => `<itemref idref="chapter-${i + 1}"/>`).join('')}</spine></package>`;
  }
  const reportBase = {
    schemaVersion: 1 as const,
    exporterVersion: vertical ? documentEpubVerticalExporterVersion : documentEpubExporterVersion,
    basis,
    format: vertical ? ('epub3-vertical' as const) : ('epub3-horizontal' as const),
    metadata: book,
    sources: clone(sequence.manifest),
    chapters,
    resources,
    diagnostics,
  };
  const estimate =
    Object.values(files).reduce((n, f) => n + byteLength(f), 20) +
    strToU8(JSON.stringify({ ...reportBase, planHash: '0'.repeat(64) }, null, 2)).length +
    strToU8(JSON.stringify(sequence.manifest, null, 2)).length;
  if (estimate > documentEpubLimits.bytes)
    add('OUTPUT_LIMIT', 'error', 'EPUB exceeds the 16 MiB uncompressed output boundary');
  const report = deepFreeze({
    ...reportBase,
    // Binary files are bound to the plan by the SHA-256 recorded in `resources`.
    planHash: await contentHash({
      ...reportBase,
      files: Object.fromEntries(
        Object.entries(files).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
    }),
  });
  checkExportAbort(signal);
  files['EPUB/sources.json'] = JSON.stringify(report.sources, null, 2);
  files['EPUB/export-report.json'] = JSON.stringify(report, null, 2);
  const plan = Object.freeze({ report }) as unknown as DocumentEpubPlan;
  plans.set(plan, { report, files });
  return plan;
}
/** Consent is tied to the owned plan; errors and unknown warning IDs cannot be waived. */
export async function encodeDocumentEpub(
  plan: DocumentEpubPlan,
  consent: ExportConsent,
  signal?: AbortSignal,
): Promise<ExportResult<DocumentEpubReport>> {
  if (signal?.aborted) return { status: 'cancelled' };
  const owned = plans.get(plan);
  if (!owned)
    return {
      status: 'failed',
      code: 'INVALID_PLAN',
      message: 'Prepare EPUB in this process before encoding',
    };
  if (!acceptsExport(owned.report, consent)) return { status: 'blocked', report: owned.report };
  try {
    checkExportAbort(signal);
    const files: Zippable = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
    for (const [path, value] of Object.entries(owned.files))
      files[path] = typeof value === 'string' ? strToU8(value) : value;
    const total = Object.values(owned.files).reduce((n, f) => n + byteLength(f), 20);
    if (total > documentEpubLimits.bytes) throw Error('EPUB output boundary exceeded');
    const bytes = zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) });
    checkExportAbort(signal);
    return { status: 'ok', bytes, mime: 'application/epub+zip', report: owned.report };
  } catch {
    return signal?.aborted
      ? { status: 'cancelled' }
      : {
          status: 'failed',
          code: 'ENCODE_FAILED',
          message: 'EPUB encoding failed; no partial file was produced',
        };
  }
}
