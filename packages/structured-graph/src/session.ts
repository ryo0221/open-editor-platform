import { canonicalJson, clone, newId } from '@editor-platform/artifact-core';
import {
  EditorSession,
  type EditorCommand,
  type LocalDraftRevision,
} from '@editor-platform/editor-core';
import { type GraphDocument } from './model';
import { assertGraph, type GraphProfile } from './profile';
import { graphCommand, guardGraphCommand, parseGraphIntents, type GraphIntent } from './commands';
export interface GraphProposal {
  id: string;
  base: string;
  intents: GraphIntent[];
}
/** Local only. External sources use GraphBinding and retain their own canonical session. */
export class GraphSession {
  private readonly session: EditorSession<GraphDocument>;
  readOnly = false;
  constructor(
    content: GraphDocument,
    readonly profile: GraphProfile,
  ) {
    assertGraph(content, profile);
    this.session = new EditorSession(content);
  }
  get content() {
    return this.session.content;
  }
  get revision(): LocalDraftRevision {
    return this.session.revision;
  }
  get stamp() {
    return canonicalJson({ revision: this.revision, profile: this.profile });
  }
  get canUndo() {
    return this.session.canUndo;
  }
  get canRedo() {
    return this.session.canRedo;
  }
  execute(value: unknown, base = this.stamp) {
    if (base !== this.stamp) throw new Error('Stale Graph projection');
    return this.executeCommand(graphCommand(this.profile, value));
  }
  executeCommand(cmd: EditorCommand<GraphDocument>) {
    return this.session.execute(guardGraphCommand(cmd, this.profile, () => !this.readOnly));
  }
  undo() {
    if (this.readOnly) throw new Error('Graph is read only');
    return this.session.undo();
  }
  redo() {
    if (this.readOnly) throw new Error('Graph is read only');
    return this.session.redo();
  }
  preview(value: unknown): { proposal: GraphProposal; content: GraphDocument } {
    const intents = parseGraphIntents(value);
    return {
      proposal: { id: newId('proposal'), base: this.stamp, intents: clone(intents) },
      content: graphCommand(this.profile, intents).apply(this.content),
    };
  }
  apply(proposal: GraphProposal) {
    return this.execute(proposal.intents, proposal.base);
  }
}
