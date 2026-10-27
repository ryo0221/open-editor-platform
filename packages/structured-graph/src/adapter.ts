import { canonicalJson, clone, newId } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import {
  isGraphJson,
  validNodePresentations,
  type GraphDiagnostic,
  type GraphDocument,
  type GraphNodePresentations,
} from './model';
import { assertGraph, type GraphProfile } from './profile';
import {
  graphCommand,
  isGraphSectionIntent,
  parseGraphIntents,
  type GraphIntent,
} from './commands';
export interface GraphAdapter<S> {
  id: string;
  version: number;
  profile(source: S): GraphProfile;
  /** `presentation` is the Host sidecar's node presentation when the mode is `sidecar`. */
  project(source: S, presentation?: GraphNodePresentations): GraphDocument;
  /** Pure. Must preserve unsupported source fields and use the source's own validation boundary. */
  prepare(source: S, intents: GraphIntent[]): EditorCommand<S>;
  diagnostics?(source: S): GraphDiagnostic[];
  /**
   * Where node presentation (position, shape, style) is saved. `sidecar` keeps it in a
   * Host-owned sidecar apart from semantic content; `source` lets prepare accept or refuse
   * presentation intents; `none` refuses them and draws Profile defaults. Default `source`.
   */
  presentationMode?: 'sidecar' | 'source' | 'none';
  /** Sections need `presentationMode: 'source'`. Section editing is not implemented yet. */
  sections?: boolean;
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
export interface PresentationSidecar {
  schemaVersion: 2;
  sourceId: string;
  sourceRevision: string;
  adapter: { id: string; version: number };
  profile: { id: string; version: number };
  /** Sidecar adapters cannot hold Sections, so only node presentation is stored. */
  presentation: { nodes: GraphNodePresentations };
}
const presentationIntents = new Set<GraphIntent['type']>([
  'move-node',
  'set-node-shape',
  'set-node-style',
]);
/** A binding has no source copy or Undo stack. The Host supplies the sole executor. */
export class GraphBinding<S> {
  constructor(
    readonly options: {
      adapter: GraphAdapter<S>;
      read: () => GraphSource<S>;
      execute: (command: EditorCommand<S>) => void;
      sourceId: string;
      getPresentation?: () => PresentationSidecar | undefined;
      setPresentation?: (sidecar: PresentationSidecar) => void;
    },
  ) {
    const { adapter } = options;
    if (adapter.sections && (adapter.presentationMode ?? 'source') !== 'source')
      throw new Error('Graph sections need an adapter that saves presentation in its source');
  }
  private get mode() {
    return this.options.adapter.presentationMode ?? 'source';
  }
  private stamp(source: GraphSource<S>) {
    return canonicalJson({
      revision: source.revision,
      fingerprint: canonicalJson(source.content),
      adapter: { id: this.options.adapter.id, version: this.options.adapter.version },
      profile: this.options.adapter.profile(source.content),
      presentation: this.mode === 'sidecar' ? (this.options.getPresentation?.() ?? null) : null,
    });
  }
  project(): GraphProjection {
    const source = this.options.read(),
      adapter = this.options.adapter,
      profile = adapter.profile(source.content),
      sidecar = this.mode === 'sidecar' ? this.options.getPresentation?.() : undefined;
    let presentation: GraphNodePresentations | undefined;
    if (sidecar) {
      if (
        !isGraphJson(sidecar) ||
        sidecar.schemaVersion !== 2 ||
        sidecar.sourceId !== this.options.sourceId ||
        sidecar.adapter.id !== adapter.id ||
        sidecar.adapter.version !== adapter.version ||
        sidecar.profile.id !== profile.id ||
        sidecar.profile.version !== profile.version ||
        Object.keys(sidecar).length !== 6 ||
        Object.keys(sidecar.presentation ?? {}).join() !== 'nodes' ||
        !validNodePresentations(sidecar.presentation.nodes)
      )
        throw new Error('Unknown or incompatible Graph presentation sidecar');
      // Values for nodes the source no longer has are ignored and dropped on the next write.
      const ids = new Set(adapter.project(clone(source.content)).nodes.map((n) => n.id));
      presentation = Object.fromEntries(
        Object.entries(clone(sidecar.presentation.nodes)).filter(([id]) => ids.has(id)),
      );
    }
    const graph = adapter.project(clone(source.content), presentation);
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
    if (!this.options.adapter.sections && intents.some(isGraphSectionIntent))
      throw new Error('This source cannot represent Graph sections');
    const projected = this.project();
    graphCommand(projected.profile, intents).apply(projected.graph);
    const looks = intents.filter((i) => presentationIntents.has(i.type));
    if (
      this.mode === 'none' &&
      intents.some((i) => i.type === 'set-node-shape' || i.type === 'set-node-style')
    )
      throw new Error('This source cannot save node shapes or styles');
    if (this.mode === 'sidecar' && looks.length) {
      if (looks.length !== intents.length)
        throw new Error('Sidecar presentation and semantic edits require separate transactions');
      if (!this.options.setPresentation)
        throw new Error('Host has no writable presentation sidecar');
      return { intents, source, projected, presentation: true };
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
          this.mode === 'sidecar' ? clone(prepared.projected.graph.presentation.nodes) : undefined,
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
    // The validated projection already applies every presentation intent of the batch.
    const next = graphCommand(prepared.projected.profile, prepared.intents).apply(
      prepared.projected.graph,
    );
    this.options.setPresentation!({
      schemaVersion: 2,
      sourceId: this.options.sourceId,
      sourceRevision: prepared.source.revision,
      adapter: { id: this.options.adapter.id, version: this.options.adapter.version },
      profile: { id: prepared.projected.profile.id, version: prepared.projected.profile.version },
      presentation: { nodes: next.presentation.nodes },
    });
  }
  applyProposal(proposal: AdapterProposal) {
    this.apply(proposal.intents, proposal.base);
  }
}
