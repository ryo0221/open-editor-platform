import { diffElements, newId, type CompareResult } from '@editor-platform/artifact-core';
import { command, type ElementAddress, type Annotation } from '@editor-platform/editor-core';
import { patienceDiff } from './diff';
export interface ReviewFile {
  id: string;
  name: string;
  oldText: string;
  newText: string;
  oldRevision?: string;
  newRevision?: string;
}
export interface ReviewContent {
  schemaVersion: 1 | 2;
  files: ReviewFile[];
}
export interface DiffLine {
  type: 'added' | 'removed' | 'context';
  text: string;
  oldLine?: number;
  newLine?: number;
}
export interface FileContent {
  schemaVersion: 1 | 2;
  id: string;
  name: string;
  mime: string;
  size: number;
  data: string;
  /** Original bytes, also retained for decoded text (BOM/newlines/encoding are not regenerated). */
  originalData?: string;
}
export function reviewRevision(file: ReviewFile, side: 'old' | 'new') {
  return file[side === 'old' ? 'oldRevision' : 'newRevision'] ?? `legacy:${file.id}:${side}`;
}
/** Old line anchors and old source versions share the same stable revision identity. */
export function reviewAddressRevision(address: ElementAddress): string | undefined {
  const region = address.region;
  return region?.type === 'lines'
    ? (region.revisionId ?? `legacy:${address.elementId}:${region.side ?? 'new'}`)
    : undefined;
}
export function replaceComparison(id: string, oldText: string, newText: string, name?: string) {
  const oldRevision = newId('source'),
    newRevision = newId('source');
  return command<ReviewContent>('review.sources', 'Replace comparison sources', (d) => ({
    ...d,
    schemaVersion: 2,
    files: d.files.map((f) =>
      f.id === id
        ? {
            ...f,
            name: name ?? f.name,
            oldText,
            newText,
            oldRevision: oldText === f.oldText ? reviewRevision(f, 'old') : oldRevision,
            newRevision: newText === f.newText ? reviewRevision(f, 'new') : newRevision,
          }
        : f,
    ),
  }));
}
export function reviewAnchorState(
  d: ReviewContent,
  address: ElementAddress,
): 'Current' | 'Outdated' | 'Orphan' {
  const file = d.files.find((f) => f.id === address.elementId),
    r = address.region;
  if (!file) return 'Orphan';
  if (r?.type !== 'lines') return 'Current';
  const side = r.side ?? 'new';
  if (reviewAddressRevision(address) !== reviewRevision(file, side)) return 'Outdated';
  return r.start < 1 || r.end > file[side === 'old' ? 'oldText' : 'newText'].split('\n').length
    ? 'Orphan'
    : 'Current';
}
export function originalBytes(file: FileContent): Uint8Array<ArrayBuffer> {
  const source = file.originalData ?? file.data;
  if (/^data:[^,]*;base64,/.test(source))
    return Uint8Array.from(atob(source.slice(source.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  return new TextEncoder().encode(source);
}
export function createReview(): ReviewContent {
  return {
    schemaVersion: 1,
    files: [
      {
        id: newId('file'),
        name: 'example.ts',
        oldText: 'export function greet(name: string) {\n  return "Hello " + name;\n}\n',
        newText: 'export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n',
      },
      {
        id: newId('file'),
        name: 'notes.md',
        oldText: '# Notes\nFirst draft',
        newText: '# Notes\nReviewed draft',
      },
    ],
  };
}
export function lineDiff(before: string, after: string): DiffLine[] {
  return patienceDiff(before, after);
}
export const reviewDiff = (a: ReviewContent, b: ReviewContent): CompareResult => ({
  changes: diffElements(a.files, b.files).changes.map((change) => {
    const old = a.files.find((f) => f.id === change.elementId),
      next = b.files.find((f) => f.id === change.elementId);
    const describe = (f: ReviewFile) =>
      `${f.name}\nOld source:\n${f.oldText}\n\nNew source:\n${f.newText}`;
    return {
      ...change,
      path: next?.name ?? old!.name,
      before: old ? describe(old) : undefined,
      after: next ? describe(next) : undefined,
    };
  }),
});
export function createFile(kind: 'text' | 'image' | 'pdf' = 'text'): FileContent {
  let data =
      '12:00:00  INFO  Editor initialized\n12:00:01  INFO  Artifact loaded\n12:00:02  INFO  Ready to review',
    mime = 'text/plain',
    name = 'session.log';
  if (kind === 'image') {
    data =
      'data:image/svg+xml;base64,' +
      btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#e5ece6"/><circle cx="250" cy="230" r="100" fill="#648771"/><rect x="420" y="130" width="210" height="200" fill="#c2a172"/><text x="45" y="55" font-family="sans-serif" font-size="24" fill="#253a2d">Composition / 01</text></svg>',
      );
    mime = 'image/svg+xml';
    name = 'composition.svg';
  }
  if (kind === 'pdf') {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      '',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const stream = 'BT /F1 24 Tf 60 700 Td (Editor Platform - PDF sample) Tj ET';
    objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((o, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const start = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((o) => String(o).padStart(10, '0') + ' 00000 n \n')
      .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    data = 'data:application/pdf;base64,' + btoa(pdf);
    mime = 'application/pdf';
    name = 'sample.pdf';
  }
  const file: FileContent = { schemaVersion: 2, id: newId('asset'), name, mime, size: 0, data };
  file.size = originalBytes(file).length;
  return file;
}
export function isReview(value: unknown): value is ReviewContent {
  if (!value || typeof value !== 'object') return false;
  const v = value as ReviewContent;
  return (
    (v.schemaVersion === 1 || v.schemaVersion === 2) &&
    Array.isArray(v.files) &&
    v.files.every(
      (f) =>
        f &&
        ['id', 'name', 'oldText', 'newText'].every(
          (k) => typeof f[k as keyof ReviewFile] === 'string',
        ),
    )
  );
}
export function isFile(value: unknown): value is FileContent {
  if (!value || typeof value !== 'object') return false;
  const v = value as FileContent;
  return (
    (v.schemaVersion === 1 || v.schemaVersion === 2) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.mime === 'string' &&
    typeof v.data === 'string' &&
    (v.originalData === undefined ||
      (typeof v.originalData === 'string' && /^data:[^,]*;base64,/.test(v.originalData))) &&
    typeof v.size === 'number' &&
    /^(text\/|image\/(png|jpeg|gif|webp|svg\+xml)$|application\/pdf$)/.test(v.mime)
  );
}

export interface ReviewVisibleSource {
  id: string;
  name: string;
  oldRevision: string;
  newRevision: string;
}
/** Trusted submission must agree with the displayed file as well as the current source revision. */
export function assertReviewSelection(
  content: ReviewContent,
  addresses: ElementAddress[],
  visible: ReviewVisibleSource | undefined,
  artifactId: string,
) {
  if (
    !visible ||
    !addresses.length ||
    addresses.some(
      (address) =>
        address.artifactId !== artifactId ||
        address.elementId !== visible.id ||
        address.region?.type !== 'lines' ||
        reviewAnchorState(content, address) !== 'Current' ||
        address.region.revisionId !==
          (address.region.side === 'old' ? visible.oldRevision : visible.newRevision),
    )
  )
    throw new Error(
      '表示中のファイル・原本版と注釈対象が一致しません。現在の行を選び直してください。',
    );
}
export interface ReviewResolvedSource {
  name: string;
  revisionId: string;
  side: 'old' | 'new';
  text: string;
}

/** Replace only the displayed file's anchor; retain every other source reference. */
export function remapReviewAnnotation(annotation: Annotation, address: ElementAddress): Annotation {
  const index = annotation.anchor.addresses.findIndex(
    (current) =>
      current.artifactId === address.artifactId && current.elementId === address.elementId,
  );
  if (index < 0) throw new Error('再紐付けするファイルの注釈対象がありません。');
  return {
    ...annotation,
    anchor: {
      ...annotation.anchor,
      addresses: annotation.anchor.addresses.map((current, i) =>
        i === index ? { ...current, ...address } : current,
      ),
    },
  };
}

/** File replacement changes the source ID; other artifacts' anchors remain untouched. */
export function remapFileAnnotation(annotation: Annotation, address: ElementAddress): Annotation {
  const index = annotation.anchor.addresses.findIndex(
    (current) => current.artifactId === address.artifactId,
  );
  if (index < 0) throw new Error('再紐付けするファイルの注釈対象がありません。');
  return {
    ...annotation,
    anchor: {
      ...annotation.anchor,
      addresses: annotation.anchor.addresses.map((current, i) =>
        i === index ? { ...current, ...address } : current,
      ),
    },
  };
}
