import type { Artifact } from '@editor-platform/artifact-core';
import type { DocumentContent } from '@editor-platform/document/model';
import type { DocumentImportOptions } from '@editor-platform/document-import';
import type { SlideContent } from '@editor-platform/slide/model';
import type { SlideImportOptions } from '@editor-platform/slide-import';
import type {
  ImportConsent,
  OfficeImportReport,
  ReadonlyImport,
} from '@editor-platform/office-import-core';
export type ImportContent = SlideContent | DocumentContent;
export type ImportOptions = SlideImportOptions;
export type ImportRequest =
  | {
      id: number;
      action: 'prepare';
      bytes: Uint8Array;
      format: 'pptx';
      options: ImportOptions;
      requestId: string;
    }
  | {
      id: number;
      action: 'prepare';
      bytes: Uint8Array;
      format: 'docx';
      options: DocumentImportOptions;
      requestId: string;
    }
  | { id: number; action: 'materialize'; consent: ImportConsent };
export type ImportResponse =
  | {
      id: number;
      status: 'prepared';
      preview: ReadonlyImport<ImportContent>;
      report: ReadonlyImport<OfficeImportReport>;
    }
  | { id: number; status: 'materialized'; artifact: Artifact<ImportContent> }
  | { id: number; status: 'failed'; code: string; message: string };
