import type { SlideContent } from '@editor-platform/slide/model';
import type { DesignContent } from '@editor-platform/design/model';
import type { WhiteboardContent } from '@editor-platform/whiteboard/model';
import type { DocumentContent } from '@editor-platform/document/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import type { ReviewContent, FileContent } from '@editor-platform/review-surfaces/model';
import type {
  DefinitionRef,
  LockedClosure,
  ReusableDefinition,
  ReuseDomain,
} from '@editor-platform/reuse-core';
export type Domain = 'slide' | 'whiteboard' | 'design' | 'document' | 'data' | 'review' | 'file';
export type TemplateKind = 'whole' | 'fragment' | 'preset';
export type NativeContent =
  | SlideContent
  | DesignContent
  | WhiteboardContent
  | DocumentContent
  | StructuredData
  | ReviewContent
  | FileContent;
export type Path = (string | number)[];
export type InputValue =
  | string
  | number
  | boolean
  | null
  | InputValue[]
  | { [key: string]: InputValue };
export interface InputField {
  key: string;
  label: string;
  description: string;
  type:
    | 'text'
    | 'rich-text'
    | 'number'
    | 'boolean'
    | 'date'
    | 'enum'
    | 'asset'
    | 'url'
    | 'object'
    | 'list'
    | 'table'
    | 'chart';
  required?: boolean;
  default?: InputValue;
  example?: InputValue;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: string[];
  fields?: InputField[];
  item?: InputField;
}
export interface Binding {
  slot: string;
  path: Path;
  mode: 'value' | 'text' | 'rich' | 'list' | 'table' | 'chart' | 'asset';
  /** Missing optional assets remove their containing image record. */
  optional?: boolean;
}
export interface RepeatBinding {
  slot: string;
  path: Path;
  prototype: unknown[];
  bindings: Binding[];
  columns?: number;
  stepX?: number;
  stepY?: number;
  /** Group input items into pages; bind the chunk with slot "$". */
  chunkSize?: number;
  append?: boolean;
  /** Insert repeated native records before this stable sibling ID. */
  beforeId?: string;
}
export type StructureLayout = 'auto' | 'horizontal' | 'vertical';
/** One bounded native repeat, with stable item identities; bodies remain native. */
export interface TemplateStructure {
  schemaVersion: 1;
  unit: string;
  repeat: number;
  itemId: string;
  labelRole: string;
  min: number;
  max: number;
  columns: number;
  layoutSlot: string;
  /** Native container used as the relative geometry origin. */
  anchor?: string;
  /** Whiteboard flow connects these repeated native roles in item order. */
  flowRole?: string;
  /** Purposeful native targets; scoped Design children use role/sourcePart addresses. */
  appearance?: { emphasis: string; description: string; image: string };
}
export interface TemplateAsset {
  id: string;
  data: string;
  hash: string;
  mime: string;
}
export interface PresetSpec {
  fields: Record<string, InputValue>;
  scope: 'selection' | 'artifact' | 'view';
}
export interface TemplateComposition {
  schemaVersion: 1;
  libraryId: string;
  members: { instanceId: string; reuse: 'copy' | 'linked' }[];
  bindings: { slot: string; instanceId: string; propertyId: string }[];
}
export interface TemplateDefinition {
  schemaVersion: 1;
  templateId: string;
  templateVersion: number;
  hash: string;
  name: string;
  description: string;
  purpose: string;
  category: string;
  tags: string[];
  locales: string[];
  domain: Domain;
  kind: TemplateKind;
  artifactSchema: number;
  capabilities: string[];
  targets: string[];
  content?: NativeContent;
  /** Creation recipe; each member's native content remains in its domain model. */
  composition?: TemplateComposition;
  structure?: TemplateStructure;
  preset?: PresetSpec;
  inputs: InputField[];
  sample: Record<string, InputValue>;
  bindings: Binding[];
  repeats: RepeatBinding[];
  assets: TemplateAsset[];
  overflow: {
    /** Opt-in effective instance text checks; absent on immutable legacy definitions. */
    textScope?: 'instance';
    policy: 'reflow' | 'paginate' | 'expand' | 'error';
    maxItems: number;
    minFontSize: number;
  };
  preview: { renderer: 'native'; description: string };
}
export interface Diagnostic {
  code: string;
  path: string;
  message: string;
  severity: 'error' | 'info';
}
export class TemplateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}
export function problem(code: string, message: string, path = ''): never {
  throw new TemplateError(code, message, [{ code, path, message, severity: 'error' }]);
}
export interface CatalogQuery {
  domain?: Domain;
  kind?: TemplateKind;
  category?: string;
  search?: string;
  locale?: string;
  capabilities?: string[];
  archived?: boolean;
}
export interface CatalogAdapter {
  list(query?: CatalogQuery): Promise<TemplateDefinition[]>;
  getVersion(id: string, version: number): Promise<TemplateDefinition | undefined>;
  put(value: TemplateDefinition): Promise<void>;
  putMany?(values: TemplateDefinition[]): Promise<void>;
  archive(id: string, archived: boolean): Promise<void>;
  listReusable?(query?: ReusableQuery): Promise<ReusableDefinition<unknown>[]>;
  getReusable?(ref: DefinitionRef): Promise<ReusableDefinition<unknown> | undefined>;
  putBundle?(bundle: CatalogBundle): Promise<void>;
  archiveReusable?(libraryId: string, definitionId: string, archived: boolean): Promise<void>;
  listReusableDrafts?(): Promise<ReusableDraft[]>;
  saveReusableDraft?(draft: ReusableDraft, expectedRevision: number | null): Promise<void>;
  deleteReusableDraft?(id: string, expectedRevision: number): Promise<void>;
}
export interface ReusableQuery {
  domain?: ReuseDomain;
  kind?: DefinitionRef['kind'];
  search?: string;
  archived?: boolean;
}
export interface CatalogBundle {
  templates: TemplateDefinition[];
  reusable: LockedClosure<unknown>[];
  /** Consume a reviewed mutable draft in the same atomic publication transaction. */
  publishDraft?: { id: string; revision: number };
}
export interface ReusableDraft {
  id: string;
  revision: number;
  base?: DefinitionRef;
  ref: DefinitionRef;
  closure: LockedClosure<unknown>;
}
export const domains: Domain[] = [
  'slide',
  'whiteboard',
  'design',
  'document',
  'data',
  'review',
  'file',
];
export const capabilities = [
  'native-content',
  'typed-inputs',
  'repeat-layout',
  'checked-apply',
  'variable-composition',
];
