import type {
  ConfirmedVersion,
  Identity,
  Preview,
  Proposal,
  ProposalState,
  Receipt,
} from '@editor-platform/collaboration-core';
import { HttpSyncAdapter } from './http';
import type { EditorHostAdapter } from './editor-session';
import type { EditorAsset } from './editor-assets';
/** HTTP implementation of injected editor services. Authentication/routing is supplied by Host. */
export class HttpEditorAdapter<T> extends HttpSyncAdapter<T> implements EditorHostAdapter<T> {
  registerAsset(reference: EditorAsset, data: string) {
    return this.request<void>('/editor/asset', { reference, data });
  }
  undo(id: string, redo = false) {
    return this.request<Receipt>('/undo', { id, redo });
  }
  versions() {
    return this.request<ConfirmedVersion<T>[]>('/versions');
  }
  save(reason: string) {
    return this.request<ConfirmedVersion<T>>('/version', { reason });
  }
  restore(versionId: string, expectedRevision: number) {
    return this.request<Receipt>('/restore-version', { versionId, expectedRevision });
  }
  registerProposal(value: Proposal) {
    return this.request<ProposalState>('/proposal/register', value);
  }
  previewProposal(id: string) {
    return this.request<Preview<T>>('/proposal/preview', { id });
  }
  applyProposal(id: string, token: string) {
    return this.request<Receipt>('/proposal/apply', { id, token });
  }
  cancelProposal(id: string, reject = false) {
    return this.request<ProposalState>('/proposal/cancel', { id, reject });
  }
}
export interface EditorConnectionCredentials {
  token: string;
  identity: Identity;
  name: string;
}
