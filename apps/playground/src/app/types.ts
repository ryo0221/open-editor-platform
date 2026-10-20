import type { SharedEditorSession } from '@editor-platform/collaboration-adapters';
import type { Content, StoredArtifact } from '../model';

export interface SharedPlaygroundConnection {
  session: SharedEditorSession<Content>;
  record: StoredArtifact;
  peerUrl: string;
  requestProposal(): Promise<string>;
  leave(): void;
  hostActions?: { label: string; run(): void | Promise<void> }[];
}
