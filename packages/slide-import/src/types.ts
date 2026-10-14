import type { SlideContent } from '@editor-platform/slide/model';
import type { OfficeImportOptions, OfficeImportPlan } from '@editor-platform/office-import-core';
export interface SlideImportOptions extends OfficeImportOptions {
  pages: 'all' | readonly number[];
  includeHidden: boolean;
  notes: 'include' | 'exclude';
}
export type SlideImportPlan = OfficeImportPlan<SlideContent>;
export interface SlideImportAdapters {
  /** Identity participates in the plan hash. Decoders receive owned bytes, never URLs. */
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
