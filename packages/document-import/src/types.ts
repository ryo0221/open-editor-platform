import type { DocumentContent } from '@editor-platform/document/model';
import type { OfficeImportOptions, OfficeImportPlan } from '@editor-platform/office-import-core';
export type DocumentImportOptions = OfficeImportOptions;
export type DocumentImportPlan = OfficeImportPlan<DocumentContent>;
export interface DocumentImportAdapters {
  version: string;
  decodeImage?(
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{
    bytes: Uint8Array;
    mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    width: number;
    height: number;
  }>;
}
