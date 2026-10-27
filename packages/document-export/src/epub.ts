import { clone, contentHash, deepFreeze } from '@editor-platform/artifact-core';
import {
  composeDocumentSequence,
  type DocumentSequenceSource,
  type DocumentSequenceManifest,
} from '@editor-platform/document/sequence';
import {
  documentStyleCss,
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
  format: 'epub3-horizontal';
  metadata: DocumentEpubMetadata;
  sources: DocumentSequenceManifest;
  chapters: {
    sourceIndex: number;
    path: string;
    title: string;
    elements: { sourceId: string; derivedId: string; xhtmlId: string }[];
  }[];
}
declare const epubBrand: unique symbol;
export interface DocumentEpubPlan {
  readonly [epubBrand]: true;
  readonly report: ReadonlyTree<DocumentEpubReport>;
}
const plans = new WeakMap<
  DocumentEpubPlan,
  { report: ReadonlyTree<DocumentEpubReport>; files: Record<string, string> }
>();
export const documentEpubLimits = Object.freeze({ bytes: 16 * 1024 * 1024, creators: 16 });
export const documentEpubExporterVersion = 'epub-horizontal/1.0.0';
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
function inline(span: InlineSpan) {
  let result = xml(span.text).replace(/\n/g, '<br/>');
  if (span.code) result = `<code>${result}</code>`;
  if (span.bold) result = `<strong>${result}</strong>`;
  if (span.italic) result = `<em>${result}</em>`;
  if (span.strike) result = `<s>${result}</s>`;
  const css = [
    span.bold === false ? 'font-weight:400' : '',
    span.underline ? 'text-decoration:underline' : '',
    span.color ? `color:${span.color}` : '',
    span.highlight ? `background-color:${span.highlight}` : '',
  ]
    .filter(Boolean)
    .join(';');
  return css ? `<span style="${xml(css)}">${result}</span>` : result;
}
const xhtml = (title: string, language: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(language)}" lang="${xml(language)}"><head><meta charset="UTF-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;

/** Exact chapter versions are captured before the first await. Output is a derived local
 * projection; the report's basis is not a new saved Artifact or an invented version. */
export async function prepareDocumentEpub(
  input: readonly DocumentSequenceSource[],
  metadata: DocumentEpubMetadata,
  signal?: AbortSignal,
): Promise<DocumentEpubPlan> {
  checkExportAbort(signal);
  const sources = clone(input),
    settings = ownMetadata(metadata);
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
  add(
    'REFLOW_FONT_DIFFERENCE',
    'warning',
    'Horizontal reflowable EPUB uses reader fonts. Page settings, native fonts, line breaks, vertical text, ruby and fixed pagination are not preserved.',
  );
  for (const block of content.blocks) {
    if (!xmlText(block.text) || block.rich?.some((s) => !xmlText(s.text)))
      add(
        'INVALID_XML_TEXT',
        'error',
        'Text contains characters not representable in XML 1.0',
        block.id,
      );
    if (block.rich?.some((s) => s.link))
      add(
        'LINK_UNSUPPORTED',
        'error',
        'Links require a separate target mapping and are not supported by the initial EPUB subset',
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
  const files: Record<string, string> = {};
  if (!diagnostics.some((d) => d.severity === 'error')) {
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
      const path = `chapter-${String(source.order + 1).padStart(3, '0')}.xhtml`;
      const elements: DocumentEpubReport['chapters'][number]['elements'] = [];
      const paragraphs: string[] = [];
      for (const [index, mapping] of source.elements.entries()) {
        const block = byId.get(mapping.outputId)!;
        if (block.hidden) continue;
        const id = `block-${index + 1}`;
        elements.push({ sourceId: mapping.sourceId, derivedId: mapping.outputId, xhtmlId: id });
        const tag = block.type === 'heading' ? `h${block.level ?? 1}` : 'p';
        const css =
          (documentStyleCss(block.style) ? documentStyleCss(block.style) + ';' : '') +
          (block.align ? `text-align:${block.align};` : '') +
          (block.indent ? `margin-left:${block.indent * 1.5}em;` : '');
        paragraphs.push(
          `<${tag} id="${id}"${css ? ` style="${xml(css)}"` : ''}>${(block.rich ?? [{ text: block.text }]).map(inline).join('')}</${tag}>`,
        );
      }
      chapters.push({ sourceIndex: source.order, path: 'EPUB/' + path, title, elements });
      files['EPUB/' + path] = xhtml(title, book.language, paragraphs.join('\n'));
    }
    files['EPUB/style.css'] =
      'html { writing-mode: horizontal-tb; } body { font-family: serif; line-height: 1.6; } p,h1,h2,h3,h4,h5,h6 { white-space: pre-wrap; }';
    files['EPUB/nav.xhtml'] = xhtml(
      'Contents',
      book.language,
      `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${chapters.map((c) => `<li><a href="${c.path.slice(5)}">${xml(c.title)}</a></li>`).join('')}</ol></nav>`,
    );
    files['META-INF/container.xml'] =
      '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
    files['EPUB/package.opf'] =
      `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${xml(book.identifier)}</dc:identifier><dc:title>${xml(book.title)}</dc:title><dc:language>${xml(book.language)}</dc:language>${book.creators.map((c) => `<dc:creator>${xml(c)}</dc:creator>`).join('')}<meta property="dcterms:modified">${book.modified}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="style.css" media-type="text/css"/><item id="sources" href="sources.json" media-type="application/json"/><item id="report" href="export-report.json" media-type="application/json"/>${chapters.map((c, i) => `<item id="chapter-${i + 1}" href="${c.path.slice(5)}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine page-progression-direction="ltr">${chapters.map((_, i) => `<itemref idref="chapter-${i + 1}"/>`).join('')}</spine></package>`;
  }
  const reportBase = {
    schemaVersion: 1 as const,
    exporterVersion: documentEpubExporterVersion,
    basis,
    format: 'epub3-horizontal' as const,
    metadata: book,
    sources: clone(sequence.manifest),
    chapters,
    diagnostics,
  };
  const estimate =
    Object.values(files).reduce((n, f) => n + strToU8(f).length, 20) +
    strToU8(JSON.stringify({ ...reportBase, planHash: '0'.repeat(64) }, null, 2)).length +
    strToU8(JSON.stringify(sequence.manifest, null, 2)).length;
  if (estimate > documentEpubLimits.bytes)
    add('OUTPUT_LIMIT', 'error', 'EPUB exceeds the 16 MiB uncompressed output boundary');
  const report = deepFreeze({
    ...reportBase,
    planHash: await contentHash({ ...reportBase, files }),
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
    for (const [path, value] of Object.entries(owned.files)) files[path] = strToU8(value);
    const total = Object.values(owned.files).reduce((n, f) => n + strToU8(f).length, 20);
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
