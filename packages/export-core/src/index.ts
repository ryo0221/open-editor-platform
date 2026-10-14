import { canonicalJson, clone, contentHash, deepFreeze } from '@editor-platform/artifact-core';
export { exportColor } from './color';

/** Export contracts only: no persisted content model, renderer or encoder dependency. */
export type ReadonlyTree<T> = T extends object
  ? { readonly [K in keyof T]: ReadonlyTree<T[K]> }
  : T;
export type CaptureBasis =
  | { kind: 'local-draft'; artifactId: string }
  | { kind: 'confirmed'; artifactId: string; revision: number }
  | { kind: 'saved-version'; artifactId: string; versionId: string };
export type ExportBasis = CaptureBasis & { contentHash: string };
export interface ExportSnapshot<T> {
  readonly content: ReadonlyTree<T>;
  readonly basis: ReadonlyTree<ExportBasis>;
}

/** Ownership is acquired synchronously, before the hash's first asynchronous boundary. */
export async function captureExportSnapshot<T>(
  content: T,
  basis: CaptureBasis,
): Promise<ExportSnapshot<T>> {
  const owned = deepFreeze(clone(content));
  const origin = deepFreeze(clone(basis));
  return deepFreeze({
    content: owned as ReadonlyTree<T>,
    basis: { ...origin, contentHash: await contentHash(owned) },
  });
}
export function validExportBasis(value: ExportBasis): boolean {
  return (
    !!value &&
    typeof value.artifactId === 'string' &&
    !!value.artifactId &&
    typeof value.contentHash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.contentHash) &&
    (value.kind === 'local-draft' ||
      (value.kind === 'confirmed' && Number.isSafeInteger(value.revision) && value.revision >= 0) ||
      (value.kind === 'saved-version' && typeof value.versionId === 'string' && !!value.versionId))
  );
}
export interface SlideExportAddress {
  domain: 'slide';
  slideId?: string;
  elementId?: string;
  path?: string;
}
export interface DocumentExportAddress {
  domain: 'document';
  blockId?: string;
  itemId?: string;
  cell?: { row: number; column: number };
  paragraph?: number;
  path?: string;
}
export type ExportAddress = SlideExportAddress | DocumentExportAddress;
export interface ExportDiagnostic<A extends ExportAddress = ExportAddress> {
  id: string;
  code: string;
  severity: 'info' | 'warning' | 'error';
  address?: A;
  bounds?: { x: number; y: number; width: number; height: number };
  message: string;
  effect: 'none' | 'appearance' | 'editability' | 'omitted-by-choice' | 'blocked';
  requiresAcceptance: boolean;
}
export interface ExportConsent {
  planHash: string;
  acceptedDiagnosticIds: readonly string[];
}
export interface ExportReport<A extends ExportAddress = ExportAddress> {
  schemaVersion: 1;
  exporterVersion: string;
  planHash: string;
  basis: ExportBasis;
  diagnostics: ExportDiagnostic<A>[];
}
export type ExportResult<R extends ExportReport> =
  | { status: 'ok'; bytes: Uint8Array; mime: string; report: ReadonlyTree<R> }
  | { status: 'blocked'; report: ReadonlyTree<R> }
  | { status: 'cancelled' }
  | { status: 'failed'; code: 'ENCODE_FAILED' | 'INVALID_PLAN'; message: string };

/** IDs use machine codes and domain addresses, never localized message text. */
export function exportDiagnostic<A extends ExportAddress>(
  code: string,
  severity: ExportDiagnostic['severity'],
  message: string,
  address?: A,
  effect: ExportDiagnostic['effect'] = severity === 'error' ? 'blocked' : 'none',
): ExportDiagnostic<A> {
  const key = canonicalJson(address ?? {});
  return {
    id: `${code}/${encodeURIComponent(key)}`,
    code,
    severity,
    message,
    address,
    effect,
    requiresAcceptance: severity === 'warning',
  };
}
/** Must be called with the private owned report, not a caller's replacement JSON. */
export function acceptsExport(report: ReadonlyTree<ExportReport>, consent: ExportConsent): boolean {
  if (
    !consent ||
    consent.planHash !== report.planHash ||
    !Array.isArray(consent.acceptedDiagnosticIds) ||
    report.diagnostics.some((d) => d.severity === 'error')
  )
    return false;
  const accepted = new Set(consent.acceptedDiagnosticIds);
  const required = new Set(report.diagnostics.filter((d) => d.requiresAcceptance).map((d) => d.id));
  return (
    [...required].every((id) => accepted.has(id)) && [...accepted].every((id) => required.has(id))
  );
}
export function checkExportAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
}
/** An injected adapter can explain a known, non-waivable preparation limitation. */
export class ExportAdapterError extends Error {
  constructor(
    readonly code: 'RASTER_TEXT_STYLE_UNSUPPORTED',
    message: string,
  ) {
    super(message);
    this.name = 'ExportAdapterError';
  }
}
export async function hashExportBytes(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface ExportAsset {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** The injected resolver must decode/validate the original, not trust its filename. */
  width: number;
  height: number;
}
export interface ExportAssetAdapter {
  resolveAsset(source: string, signal?: AbortSignal): Promise<ExportAsset>;
}
export interface ExportFontProfile {
  id: string;
  family: string;
  version: string;
  license: string;
  verified: boolean;
  faces: { weight: 'regular' | 'bold'; sha256: string }[];
  /** Inclusive Unicode ranges verified in every declared face. */
  glyphRanges: [number, number][];
}
export interface ExportFontAdapter {
  resolveFont(profileId: string, signal?: AbortSignal): Promise<ExportFontProfile>;
}
export interface ExportRasterAdapter<T> {
  rasterize(input: ReadonlyTree<T>, signal?: AbortSignal): Promise<ExportAsset>;
}
export const exportAssetLimits = Object.freeze({
  bytesPerImage: 16 * 1024 * 1024,
  decodedPixels: 32_000_000,
  totalBytes: 64 * 1024 * 1024,
});
/** Copy immediately after resolution; owned bytes are private, never deep-frozen. */
export function ownExportAsset(asset: ExportAsset): ExportAsset {
  if (
    !asset ||
    !(asset.bytes instanceof Uint8Array) ||
    !asset.bytes.byteLength ||
    asset.bytes.byteLength > exportAssetLimits.bytesPerImage ||
    !Number.isSafeInteger(asset.width) ||
    asset.width < 1 ||
    !Number.isSafeInteger(asset.height) ||
    asset.height < 1 ||
    asset.width * asset.height > exportAssetLimits.decodedPixels
  )
    throw new Error('Invalid image or image limit exceeded');
  const bytes = new Uint8Array(asset.bytes);
  const has = (start: number, values: number[]) => values.every((v, i) => bytes[start + i] === v);
  const signature =
    (asset.mime === 'image/png' &&
      bytes.length >= 24 &&
      has(0, [137, 80, 78, 71, 13, 10, 26, 10])) ||
    (asset.mime === 'image/jpeg' && has(0, [255, 216, 255])) ||
    (asset.mime === 'image/gif' &&
      has(0, [71, 73, 70, 56]) &&
      [55, 57].includes(bytes[4]) &&
      bytes[5] === 97) ||
    (asset.mime === 'image/webp' && has(0, [82, 73, 70, 70]) && has(8, [87, 69, 66, 80]));
  if (!signature) throw new Error('Image MIME/signature mismatch');
  if (asset.mime === 'image/png') {
    const view = new DataView(bytes.buffer);
    if (view.getUint32(16) !== asset.width || view.getUint32(20) !== asset.height)
      throw new Error('Image dimensions do not match its bytes');
  }
  return { bytes, mime: asset.mime, width: asset.width, height: asset.height };
}
export function validFontProfile(font: ExportFontProfile, id: string): boolean {
  return (
    !!font &&
    font.id === id &&
    typeof font.family === 'string' &&
    !!font.family &&
    typeof font.version === 'string' &&
    !!font.version &&
    typeof font.license === 'string' &&
    !!font.license &&
    typeof font.verified === 'boolean' &&
    Array.isArray(font.faces) &&
    ['regular', 'bold'].every((weight) =>
      font.faces.some((f) => f.weight === weight && /^[a-f0-9]{64}$/.test(f.sha256)),
    ) &&
    Array.isArray(font.glyphRanges) &&
    font.glyphRanges.length > 0 &&
    font.glyphRanges.every(
      (r) =>
        Array.isArray(r) &&
        r.length === 2 &&
        r.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 0x10ffff) &&
        r[0] <= r[1],
    )
  );
}
export function missingFontGlyphs(text: string, font: ExportFontProfile): number[] {
  return [
    ...new Set(
      Array.from(text)
        .filter((c) => !/[\n\r\t]/.test(c))
        .map((c) => c.codePointAt(0)!),
    ),
  ].filter((n) => !font.glyphRanges.some(([start, end]) => n >= start && n <= end));
}
