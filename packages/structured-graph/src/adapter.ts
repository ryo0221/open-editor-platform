import { canonicalJson, clone, newId } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import {
  isGraphJson,
  validGraphLayout,
  type GraphDiagnostic,
  type GraphDocument,
  type GraphLayout,
} from './model';
import { assertGraph, type GraphProfile } from './profile';
import { graphCommand, parseGraphIntents, type GraphIntent } from './commands';
export interface GraphAdapter<S> {
  id: string;
  version: number;
  profile(source: S): GraphProfile;
  project(source: S, layout?: GraphLayout): GraphDocument;
  /** Pure. Must preserve unsupported source fields and use the source's own validation boundary. */
  prepare(source: S, intents: GraphIntent[]): EditorCommand<S>;
  diagnostics?(source: S): GraphDiagnostic[];
  /** Sidecar layout is separate from semantic content; otherwise prepare owns move intents. */
  layoutMode?: 'sidecar' | 'source';
}
export interface GraphSource<S> {
  content: S;
  revision: string;
  readOnly: boolean;
}
export interface GraphProjection {
  graph: GraphDocument;
  profile: GraphProfile;
  stamp: string;
  diagnostics: GraphDiagnostic[];
}
export interface AdapterProposal {
  id: string;
  base: string;
  intents: GraphIntent[];
}
export interface LayoutSidecar {
  schemaVersion: 1;
  sourceId: string;
  sourceRevision: string;
  adapter: { id: string; version: number };
  profile: { id: string; version: number };
  positions: GraphLayout;
}
/** A binding has no source copy or Undo stack. The Host supplies the sole executor. */
export class GraphBinding<S> {
  constructor(
    readonly options: {
      adapter: GraphAdapter<S>;
      read: () => GraphSource<S>;
      execute: (command: EditorCommand<S>) => void;
      sourceId: string;
      getLayout?: () => LayoutSidecar | undefined;
      setLayout?: (sidecar: LayoutSidecar) => void;
    },
  ) {}
  private stamp(source: GraphSource<S>) {
    return canonicalJson({
      revision: source.revision,
      fingerprint: canonicalJson(source.content),
      adapter: { id: this.options.adapter.id, version: this.options.adapter.version },
      profile: this.options.adapter.profile(source.content),
      layout:
        this.options.adapter.layoutMode === 'sidecar' ? (this.options.getLayout?.() ?? null) : null,
    });
  }
  project(): GraphProjection {
    const source = this.options.read(),
      adapter = this.options.adapter,
      profile = adapter.profile(source.content),
      sidecar = this.options.getLayout?.();
    let layout: GraphLayout | undefined;
    if (sidecar) {
      if (
        !isGraphJson(sidecar) ||
        sidecar.schemaVersion !== 1 ||
        sidecar.sourceId !== this.options.sourceId ||
        sidecar.adapter.id !== adapter.id ||
        sidecar.adapter.version !== adapter.version ||
        sidecar.profile.id !== profile.id ||
        sidecar.profile.version !== profile.version ||
        !validGraphLayout(sidecar.positions)
      )
        throw new Error('Unknown or incompatible Graph layout sidecar');
      layout = clone(sidecar.positions);
    }
    const graph = adapter.project(clone(source.content), layout);
    assertGraph(graph, profile);
    return {
      graph,
      profile,
      stamp: this.stamp(source),
      diagnostics: adapter.diagnostics?.(clone(source.content)) ?? [],
    };
  }
  private prepare(base: string, value: unknown) {
    const intents = parseGraphIntents(value),
      source = this.options.read();
    if (source.readOnly) throw new Error('Source is read only');
    if (this.stamp(source) !== base)
      throw new Error('Stale Graph projection; source, adapter or Profile changed');
    const projected = this.project();
    graphCommand(projected.profile, intents).apply(projected.graph);
    const moves = intents.filter((i) => i.type === 'move-node');
    if (this.options.adapter.layoutMode === 'sidecar' && moves.length) {
      if (moves.length !== intents.length)
        throw new Error('Sidecar layout and semantic edits require separate transactions');
      if (!this.options.setLayout) throw new Error('Host has no writable layout sidecar');
      return { intents, source, projected, moves };
    }
    const prepared = this.options.adapter.prepare(clone(source.content), intents);
    const guarded = command<S>('graph.adapter-edit', prepared.label, (current) => {
      const latest = this.options.read();
      if (latest.readOnly) throw new Error('Source is read only');
      if (this.stamp(latest) !== base || canonicalJson(current) !== canonicalJson(source.content))
        throw new Error('Stale Graph projection');
      const next = prepared.apply(clone(current));
      const graph = this.options.adapter.project(clone(next));
      assertGraph(graph, this.options.adapter.profile(next));
      return next;
    });
    return { intents, source, projected, guarded };
  }
  preview(value: unknown): { proposal: AdapterProposal; projection: GraphProjection; source: S } {
    const base = this.project().stamp,
      prepared = this.prepare(base, value);
    const source = prepared.guarded
      ? prepared.guarded.apply(clone(prepared.source.content))
      : clone(prepared.source.content);
    const profile = this.options.adapter.profile(source);
    const graph = prepared.guarded
      ? this.options.adapter.project(
          clone(source),
          this.options.adapter.layoutMode === 'sidecar'
            ? clone(prepared.projected.graph.layout)
            : undefined,
        )
      : graphCommand(prepared.projected.profile, prepared.intents).apply(prepared.projected.graph);
    assertGraph(graph, profile);
    const proposal = { id: newId('proposal'), base, intents: clone(prepared.intents) };
    return {
      proposal,
      projection: {
        ...prepared.projected,
        // Preview buffers must refresh even though the canonical source has not changed.
        stamp: canonicalJson({ proposal: proposal.id, base }),
        graph,
        profile,
        diagnostics: this.options.adapter.diagnostics?.(clone(source)) ?? [],
      },
      source,
    };
  }
  apply(value: unknown, base: string) {
    const prepared = this.prepare(base, value);
    if (prepared.guarded) {
      this.options.execute(prepared.guarded);
      return;
    }
    const positions = { ...prepared.projected.graph.layout };
    for (const move of prepared.moves)
      if (move.type === 'move-node') positions[move.id] = clone(move.position);
    this.options.setLayout!({
      schemaVersion: 1,
      sourceId: this.options.sourceId,
      sourceRevision: prepared.source.revision,
      adapter: { id: this.options.adapter.id, version: this.options.adapter.version },
      profile: { id: prepared.projected.profile.id, version: prepared.projected.profile.version },
      positions,
    });
  }
  applyProposal(proposal: AdapterProposal) {
    this.apply(proposal.intents, proposal.base);
  }
}
