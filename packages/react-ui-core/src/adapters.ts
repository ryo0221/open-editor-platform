import type {
  JsonValue,
  ReactEnvironmentRef,
  ReactComponentRef,
  ReactRuntimeResolution,
  RegisteredReactComponent,
  ReactUiDiagnostic,
  ReactUiDocument,
} from './types';

/** Discovery candidates need Host/human review. No automatic catalog import or second store. */
export interface ReactRegistrationCandidate {
  kind: 'react-registration-candidate';
  sourceRevision: string;
  review: 'unreviewed';
  proposed: RegisteredReactComponent;
}
export interface ReactRegistrationSourceAdapter {
  id: string;
  readCandidates(signal: AbortSignal): Promise<{
    candidates: ReactRegistrationCandidate[];
    diagnostics: ReactUiDiagnostic[];
    sourceRevision: string;
  }>;
}
export interface ReactRuntimeAdapter {
  /** Host-specific declarative context, validated independently by its isolated renderer. */
  serializePreview?(request: ReactPreviewRequest): unknown;
  /** Generated native implementations only, supplied by the Host's reviewed registration source. */
  exportImplementations?(request: {
    components: ReactComponentRef[];
    signal: AbortSignal;
  }): Promise<{
    files: { path: string; hash: string; text: string }[];
    diagnostics: ReactUiDiagnostic[];
  }>;
  resolve(request: {
    environment: ReactEnvironmentRef;
    components: ReactComponentRef[];
    signal: AbortSignal;
  }): Promise<{ resolution?: ReactRuntimeResolution; diagnostics: ReactUiDiagnostic[] }>;
  /** Separate origin URL and pinned build identity; no Editor-main-frame component functions. */
  previewEndpoint(environment: ReactEnvironmentRef): {
    url: string;
    environment: ReactEnvironmentRef;
  };
  /** Host-owned pinned CSS/assets only; implementation packages remain original imports. */
  exportDependencies?(request: { environment: ReactEnvironmentRef; signal: AbortSignal }): Promise<{
    files: { dependencyId: string; path: string; hash: string; bytes: Uint8Array }[];
    diagnostics: ReactUiDiagnostic[];
  }>;
}
/** Bootstrap only announces transport readiness; it does not attest to any composition/runtime. */
export interface ReactPreviewBootstrap {
  protocol: 1;
  type: 'host-ready' | 'host-ready-request';
}
/** Runtime implementation must check source/origin/session/revision on every render response. */
export type ReactPreviewRequest = {
  protocol: 1;
  sessionId: string;
  requestId: string;
  revision: number;
} & (
  | {
      type: 'render';
      document: ReactUiDocument;
      mode: 'edit' | 'interact';
      viewport: { width: number; height: number };
    }
  | { type: 'restart' }
);
export type ReactPreviewResponse = {
  protocol: 1;
  sessionId: string;
  requestId: string;
  revision: number;
} & (
  | { type: 'ready'; resolution: ReactRuntimeResolution }
  | { type: 'selection'; nodeId: string }
  | { type: 'callback'; nodeId: string; event: string; arguments: JsonValue[] }
  | { type: 'error'; diagnostics: ReactUiDiagnostic[] }
);
/** External identifiers are opaque to Editor; Host attaches screen/state meaning. */
export const reactScreenProposalWidths = Object.freeze([390, 1024, 1400] as const);
export type ReactScreenProposalWidth = (typeof reactScreenProposalWidths)[number];
export interface ReactScreenProposal {
  schemaVersion: 1;
  composition: ReactUiDocument;
  externalReferences: { namespace: string; screenId: string; stateId?: string }[];
  screenshotWidths: typeof reactScreenProposalWidths;
  /** Empty for JSON-only proposals; captures, when attached, cover all declared widths. */
  screenshots: {
    width: ReactScreenProposalWidth;
    height: number;
    path: string;
    hash: string;
    fixtureHash: string;
    environmentHash: string;
  }[];
}
export interface ReactScreenshotAdapter {
  capture(request: {
    document: ReactUiDocument;
    widths: typeof reactScreenProposalWidths;
    signal: AbortSignal;
  }): Promise<{
    screenshots: ReactScreenProposal['screenshots'];
    diagnostics: ReactUiDiagnostic[];
  }>;
}
/** Serializable domain intent only. W4 translates it to the EXISTING authority/Undo path. */
export type ReactUiEdit =
  | { type: 'set-prop'; nodeId: string; prop: string; value: JsonValue }
  | { type: 'reset-prop'; nodeId: string; prop: string }
  | {
      type: 'set-binding';
      nodeId: string;
      prop: string;
      binding: import('./types').ReactUiBinding | null;
    }
  | {
      type: 'insert';
      node: import('./types').ReactUiNode;
      parent: { nodeId: string; slotId: string } | null;
      beforeId: string | null;
    }
  | {
      type: 'move';
      nodeId: string;
      parent: { nodeId: string; slotId: string } | null;
      beforeId: string | null;
    }
  | { type: 'delete'; nodeId: string }
  | {
      type: 'set-layout';
      nodeId: string;
      breakpoint: string | null;
      style: import('./types').ReactUiStyle;
    }
  | {
      type: 'adopt-component';
      nodeIds: string[];
      from: ReactComponentRef;
      to: ReactComponentRef;
      propMap: Record<string, string>;
      slotMap: Record<string, string>;
    };
