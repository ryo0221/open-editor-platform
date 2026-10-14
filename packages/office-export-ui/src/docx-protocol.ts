import type { CaptureBasis, ExportConsent } from '@editor-platform/export-core';
import type { DocumentContent } from '@editor-platform/document/model';
import type {
  DocumentDocxOptions,
  DocumentDocxPlan,
  DocumentDocxResult,
} from '@editor-platform/document-export';
import type { OfficeFontManifest } from '@editor-platform/office-adapters';

export interface MermaidSvg {
  svg: string;
  width: number;
  height: number;
}
export type DocxJobRequest =
  | {
      id: number;
      action: 'prepare';
      content: DocumentContent;
      basis: CaptureBasis;
      options: DocumentDocxOptions;
      fontManifestUrl: string;
      codeFontManifestUrl: string;
    }
  | { id: number; action: 'encode'; consent: ExportConsent }
  | {
      id: number;
      action: 'mermaid-result';
      renderId: number;
      result?: MermaidSvg;
      message?: string;
    };
export type DocxJobResponse =
  | { id: number; status: 'prepared'; report: DocumentDocxPlan['report'] }
  | { id: number; status: 'encoded'; result: DocumentDocxResult }
  | { id: number; status: 'failed'; message: string }
  | {
      id: number;
      status: 'render-mermaid';
      renderId: number;
      source: string;
      manifest: OfficeFontManifest;
      files: Uint8Array[];
    };
