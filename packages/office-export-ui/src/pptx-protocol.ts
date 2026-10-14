import type { CaptureBasis, ExportConsent, ReadonlyTree } from '@editor-platform/export-core';
import type { SlideContent } from '@editor-platform/slide/model';
import type {
  SlidePptxOptions,
  SlidePptxReport,
  SlidePptxResult,
} from '@editor-platform/slide-export';

export type PptxJobRequest =
  | {
      id: number;
      action: 'prepare';
      content: SlideContent;
      basis: CaptureBasis;
      options: SlidePptxOptions;
      fontManifestUrl: string;
    }
  | { id: number; action: 'encode'; consent: ExportConsent };
export type PptxJobResponse =
  | { id: number; status: 'prepared'; report: ReadonlyTree<SlidePptxReport> }
  | { id: number; status: 'encoded'; result: SlidePptxResult }
  | { id: number; status: 'failed'; message: string };
