export const importLimits = Object.freeze({
  compressedBytes: 32 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  entries: 10_000,
  xmlBytes: 8 * 1024 * 1024,
  xmlDepth: 64,
  xmlNodes: 200_000,
  totalXmlNodes: 1_000_000,
  slides: 100,
  objects: 10_000,
  blocks: 2_000,
  cells: 50_000,
  imageBytes: 16 * 1024 * 1024,
  imagePixels: 32_000_000,
  totalImageBytes: 64 * 1024 * 1024,
  nativeAssetCharacters: 128 * 1024 * 1024,
  textCharacters: 1_000_000,
});
export class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}
export type OfficeImportFormat = 'pptx' | 'docx';
export interface OfficeSourceAddress {
  part: string;
  elementId?: string;
  path: string;
}
export type ImportDisposition =
  | 'native'
  | 'resolved'
  | 'approximation'
  | 'image'
  | 'excluded'
  | 'blocked';
export interface ImportDiagnostic {
  id: string;
  code: string;
  disposition: ImportDisposition;
  address: OfficeSourceAddress;
  message: string;
  requiresConsent: boolean;
  excludable?: boolean;
}
export interface ImportMapping {
  source: OfficeSourceAddress;
  nativeIds: readonly string[];
}
export interface OfficeImportOptions {
  unsupported: 'reject' | 'review-conversions';
  fontProfileId: 'noto-cjk-jp-2.004';
  exclude?: readonly string[];
  name?: string;
}
export interface OfficeImportReport {
  sourceHash: string;
  format: OfficeImportFormat;
  profile: 'ooxml-transitional';
  parser: { name: 'saxes'; version: '6.0.0'; adapterVersion: string };
  domain: 'slide' | 'document';
  requestId: string;
  planHash: string;
  diagnostics: readonly ImportDiagnostic[];
  mapping: readonly ImportMapping[];
}
export interface ImportConsent {
  planHash: string;
  acceptedDiagnosticIds: readonly string[];
}
export function checkImportAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new ImportError('CANCELLED', 'Import was cancelled');
}
export async function hashImportBytes(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
export const sourceKey = (address: OfficeSourceAddress) => `${address.part}#${address.path}`;
