import type { JsonValue, ReusableDefinition, TokenSet } from '@editor-platform/reuse-core';
export type { JsonValue } from '@editor-platform/reuse-core';

/** External code is NOT a native definition closure. Host resolves these exact identities. */
export interface ReactComponentRef {
  registryId: string;
  componentId: string;
  version: string;
  contractHash: string;
  implementationHash: string;
}
export interface ReactEnvironmentRef {
  id: string;
  version: string;
  hash: string;
}
export type ReactValueSchema = (
  | { type: 'string'; maxLength?: number }
  | { type: 'number'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'asset' }
  | { type: 'enum'; values: string[] }
  | { type: 'object'; fields: Record<string, ReactFieldSchema> }
  | { type: 'array'; items: ReactValueSchema; maxItems: number }
) & { nullable?: boolean };
export interface ReactFieldSchema {
  schema: ReactValueSchema;
  required: boolean;
  default?: JsonValue;
}
export interface ReactCallbackSchema {
  parameters: ReactValueSchema[];
  returns: 'void';
}
export interface ReactImport {
  source: string;
  export: 'named' | 'default';
  name?: string;
}
export interface ReactSlotSchema {
  /** 'children' or a named ReactNode prop; never an implementation DOM address. */
  prop: string;
  minimum: number;
  maximum: number;
  accepts: { registryId: string; componentId: string }[];
}
export interface ReactControlledInput {
  valueProp: string;
  eventProp: string;
  /** Host registers a normalized callback argument, not arbitrary JS/event expressions. */
  argumentIndex: number;
}
export interface RegisteredReactComponent {
  schemaVersion: 1;
  ref: ReactComponentRef;
  name: string;
  import: ReactImport;
  props: Record<string, ReactFieldSchema>;
  events: Record<string, ReactCallbackSchema>;
  slots: Record<string, ReactSlotSchema>;
  controlledInputs: ReactControlledInput[];
  layout: 'none' | 'className' | 'style' | 'wrapper';
  /** Stable IDs into the environment's package/CSS/asset/Provider manifest. */
  requires: string[];
  sampleProps: Record<string, JsonValue>;
}
export type ReactDependency = { id: string; hash: string } & (
  | { kind: 'package'; name: string; version: string }
  | { kind: 'css'; path: string }
  | { kind: 'asset'; path: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }
  | { kind: 'provider'; import: ReactImport; props: Record<string, JsonValue> }
);
export interface ReactEnvironment {
  schemaVersion: 1;
  ref: ReactEnvironmentRef;
  reactVersion: string;
  dependencies: ReactDependency[];
  /** Provider application order is explicit, outermost first. */
  providerOrder: string[];
  stylePolicy: 'allow-literals' | 'tokens-only';
  /** Existing immutable shared token definition, pinned with its ordinary V2.2 hash. */
  tokens?: ReusableDefinition<TokenSet>;
  tokenMode?: string;
  tokenVariables: Record<string, string>;
}
export const reactUiStyleProperties = [
  'display',
  'flexDirection',
  'alignItems',
  'justifyContent',
  'flexWrap',
  'gridTemplateColumns',
  'gap',
  'padding',
  'margin',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'color',
  'backgroundColor',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'borderRadius',
  'position',
  'top',
  'left',
] as const;
export type ReactUiStyleProperty = (typeof reactUiStyleProperties)[number];
export type ReactUiStyleValue =
  | { kind: 'token'; tokenId: string }
  | { kind: 'literal'; value: string | number };
export type ReactUiStyle = Partial<Record<ReactUiStyleProperty, ReactUiStyleValue>>;
export interface ReactUiLayout {
  base: ReactUiStyle;
  /** Minimum-width overrides applied in document breakpoint order. */
  breakpoints: Record<string, ReactUiStyle>;
}
export type ReactUiBinding =
  | { kind: 'data'; input: string; path: string[] }
  | { kind: 'callback'; callback: string };
export interface ReactUiNode {
  id: string;
  component: ReactComponentRef;
  props: Record<string, JsonValue>;
  slots: Record<string, string[]>;
  bindings: Record<string, ReactUiBinding>;
  layout: ReactUiLayout;
}
export interface ReactUiDocument {
  schemaVersion: 1;
  domain: 'react-ui';
  environment: ReactEnvironment;
  /** Retained registration metadata. Original executable implementations remain Host-owned. */
  components: RegisteredReactComponent[];
  inputs: Record<string, ReactFieldSchema>;
  callbacks: Record<string, ReactCallbackSchema>;
  fixture: Record<string, JsonValue>;
  breakpoints: { id: string; minWidth: number }[];
  roots: string[];
  nodes: ReactUiNode[];
}
export interface ReactUiDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
  recovery: string;
}
/** Host attests to resolving the exact pinned implementation bytes and environment. */
export interface ReactRuntimeResolution {
  environment: ReactEnvironmentRef;
  components: ReactComponentRef[];
  dependencies: { id: string; hash: string }[];
}
export interface ReactUiInspection {
  document?: ReactUiDocument;
  diagnostics: ReactUiDiagnostic[];
}
/** Plan only in W1. No TSX or file-writing implementation is claimed. */
export interface ReactUiExportPlan {
  document: ReactUiDocument;
  fingerprint: string;
  files: readonly string[];
  imports: ReactImport[];
  dependencies: ReactDependency[];
  ownership: 'generated-directory-only';
}
export const reactUiLimits = Object.freeze({
  bytes: 4 * 1024 * 1024,
  values: 100000,
  jsonDepth: 64,
  schemaDepth: 16,
  components: 128,
  dependencies: 256,
  nodes: 2000,
  treeDepth: 32,
  fields: 128,
  breakpoints: 8,
});
