import { canonicalJson, clone, newId } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import {
  isGraphJson,
  plainRecord,
  validNodePresentations,
  type GraphDiagnostic,
  type GraphDocument,
  type GraphNodePresentations,
  type GraphPresentation,
  type GraphSectionPresentation,
  validSectionPresentation,
  validGraphId,
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
  /**
   * `presentation` is the Host sidecar's node presentation when the mode is `sidecar`. With
   * `sidecar` and `sections`, the adapter gives every Section a default frame; the binding then
   * replaces it with the frame the sidecar saved.
   */
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
  /**
   * The source can hold Sections and their membership. With `source` the frames are saved in the
   * source; with `sidecar` they are saved in the Host sidecar (schema 3). `none` cannot hold them.
   */
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
  schemaVersion: 3;
  sourceId: string;
  sourceRevision: string;
  adapter: { id: string; version: number };
  profile: { id: string; version: number };
  /** Node presentation, and the frames of Sections when the adapter declares `sections`. */
  presentation: {
    nodes: GraphNodePresentations;
    sections: Record<string, GraphSectionPresentation>;
  };
}
/** The sidecar schema this version writes; schemas 1 and 2 are read as it. */
export const presentationSidecarSchemaVersion = 3;
/**
 * One change that sets the source and the sidecar together, as one record in the Host's Undo
 * (`commitWithPresentation`). `command` checks the stamp `base` when it is applied, so the Host
 * applies it to the source before it writes `presentation`.
 */
export interface GraphPresentationCommit<S> {
  command: EditorCommand<S>;
  presentation: PresentationSidecar;
  base: string;
}
/**
 * Older sidecars read as schema 3: schema 1 (`positions`) and schema 2 (`presentation.nodes`)
 * become node presentation with no Section frames. They are written back as schema 3 on the next
 * presentation change. Other values pass through to the checks below unchanged.
 */
function upgradeSidecar(value: unknown): PresentationSidecar | undefined {
  if (value === undefined) return undefined;
  if (
    plainRecord(value) &&
    value.schemaVersion === 1 &&
    Object.keys(value).length === 6 &&
    'positions' in value
  ) {
    const { positions, ...rest } = value;
    return {
      ...rest,
      schemaVersion: 3,
      presentation: { nodes: positions, sections: {} },
    } as PresentationSidecar;
  }
  if (
    plainRecord(value) &&
    value.schemaVersion === 2 &&
    Object.keys(value).length === 6 &&
    plainRecord(value.presentation) &&
    Object.keys(value.presentation).join() === 'nodes'
  )
    return {
      ...value,
      schemaVersion: 3,
      presentation: { nodes: value.presentation.nodes, sections: {} },
    } as PresentationSidecar;
  return value as PresentationSidecar;
}
const validSectionFrames = (v: unknown): v is Record<string, GraphSectionPresentation> =>
  plainRecord(v) &&
  Object.entries(v).every(([id, frame]) => validGraphId(id) && validSectionPresentation(frame));
/** Intents that change only how the drawing looks: saved in a sidecar, never in the source. */
const presentationIntents = new Set<GraphIntent['type']>([
  'move-node',
  'set-node-shape',
  'set-node-style',
  'move-section',
  'resize-section',
  'set-section-style',
]);
/** Semantic intents that also place something: their position or frame is presentation. */
const placingIntents = new Set<GraphIntent['type']>(['add-node', 'add-section']);
type Prepared<S> =
  | { kind: 'presentation'; next: GraphDocument; source: GraphSource<S>; profile: GraphProfile }
  | { kind: 'command'; guarded: EditorCommand<S> }
  | {
      kind: 'both';
      guarded: EditorCommand<S>;
      next: GraphDocument;
      source: GraphSource<S>;
      profile: GraphProfile;
    };
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
      /**
       * Optional. Applies `command` to the source and writes `presentation` as the sidecar, both
       * or neither, as one record in the Host's Undo; Undo and Redo restore both together. When a
       * write fails, the Host restores both and throws. With it, a sidecar batch may mix
       * presentation and semantic intents (a node dropped into a Section moves and joins it in
       * one edit). Without it such a batch is refused, and `sectionDrop` is `'move-only'`.
       */
      commitWithPresentation?: (commit: GraphPresentationCommit<S>) => void;
    },
  ) {
    const { adapter } = options;
    if (adapter.sections && (adapter.presentationMode ?? 'source') === 'none')
      throw new Error(
        'Graph sections need an adapter that saves presentation in its source or a sidecar',
      );
  }
  private get mode() {
    return this.options.adapter.presentationMode ?? 'source';
  }
  /**
   * What a node drop on a Section frame may do, for `GraphSurface`'s `sectionDrop`: a sidecar Host
   * without `commitWithPresentation` cannot move a node and change its Section in one edit.
   */
  get sectionDrop(): 'membership' | 'move-only' {
    return this.mode === 'sidecar' &&
      this.options.adapter.sections &&
      !this.options.commitWithPresentation
      ? 'move-only'
      : 'membership';
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
  /** The saved sidecar presentation, checked against this binding's pins. */
  private saved(profile: GraphProfile): GraphPresentation | undefined {
    if (this.mode !== 'sidecar') return undefined;
    const sidecar = upgradeSidecar(this.options.getPresentation?.()),
      adapter = this.options.adapter;
    if (!sidecar) return undefined;
    if (
      !isGraphJson(sidecar) ||
      !plainRecord(sidecar) ||
      !plainRecord(sidecar.adapter) ||
      !plainRecord(sidecar.profile) ||
      sidecar.schemaVersion !== presentationSidecarSchemaVersion ||
      sidecar.sourceId !== this.options.sourceId ||
      sidecar.adapter.id !== adapter.id ||
      sidecar.adapter.version !== adapter.version ||
      sidecar.profile.id !== profile.id ||
      sidecar.profile.version !== profile.version ||
      Object.keys(sidecar).length !== 6 ||
      !plainRecord(sidecar.presentation) ||
      Object.keys(sidecar.presentation).sort().join() !== 'nodes,sections' ||
      !validNodePresentations(sidecar.presentation.nodes) ||
      !validSectionFrames(sidecar.presentation.sections) ||
      (!adapter.sections && Object.keys(sidecar.presentation.sections).length > 0)
    )
      throw new Error('Unknown or incompatible Graph presentation sidecar');
    return clone(sidecar.presentation);
  }
  /**
   * The adapter's projection with saved presentation laid over it. Values for nodes and Sections
   * the source no longer has are ignored (and dropped on the next write); Sections without a saved
   * frame keep the adapter's default one.
   */
  private layered(content: S, saved?: GraphPresentation): GraphDocument {
    const adapter = this.options.adapter;
    if (!saved) return adapter.project(clone(content));
    const bare = adapter.project(clone(content)),
      nodes = new Set(bare.nodes.map((n) => n.id)),
      sections = new Set(bare.sections.map((s) => s.id));
    const graph = adapter.project(
      clone(content),
      Object.fromEntries(Object.entries(saved.nodes).filter(([id]) => nodes.has(id))),
    );
    for (const [id, frame] of Object.entries(saved.sections))
      if (sections.has(id) && Object.hasOwn(graph.presentation.sections, id))
        graph.presentation.sections[id] = clone(frame);
    return graph;
  }
  project(): GraphProjection {
    const source = this.options.read(),
      adapter = this.options.adapter,
      profile = adapter.profile(source.content);
    const graph = this.layered(source.content, this.saved(profile));
    assertGraph(graph, profile);
    return {
      graph,
      profile,
      stamp: this.stamp(source),
      diagnostics: adapter.diagnostics?.(clone(source.content)) ?? [],
    };
  }
  /**
   * The adapter's command, applied only while the projection is still `base`. With `presentation`
   * the result is checked with that presentation laid over it, as the Host will save them.
   */
  private guard(
    base: string,
    source: GraphSource<S>,
    intents: GraphIntent[],
    presentation?: GraphPresentation,
  ) {
    const prepared = this.options.adapter.prepare(clone(source.content), intents);
    return command<S>('graph.adapter-edit', prepared.label, (current) => {
      const latest = this.options.read();
      if (latest.readOnly) throw new Error('Source is read only');
      if (this.stamp(latest) !== base || canonicalJson(current) !== canonicalJson(source.content))
        throw new Error('Stale Graph projection');
      const next = prepared.apply(clone(current));
      const graph = this.layered(next, presentation);
      assertGraph(graph, this.options.adapter.profile(next));
      return next;
    });
  }
  private prepare(base: string, value: unknown): Prepared<S> {
    const intents = parseGraphIntents(value),
      source = this.options.read();
    if (source.readOnly) throw new Error('Source is read only');
    if (this.stamp(source) !== base)
      throw new Error('Stale Graph projection; source, adapter or Profile changed');
    if (!this.options.adapter.sections && intents.some(isGraphSectionIntent))
      throw new Error('This source cannot represent Graph sections');
    const projected = this.project();
    // The whole batch is checked against the Profile first, so a refusal changes nothing.
    const next = graphCommand(projected.profile, intents).apply(projected.graph);
    if (
      this.mode === 'none' &&
      intents.some((i) => i.type === 'set-node-shape' || i.type === 'set-node-style')
    )
      throw new Error('This source cannot save node shapes or styles');
    if (this.mode === 'sidecar') {
      const looks = intents.filter((i) => presentationIntents.has(i.type)),
        semantic = intents.filter((i) => !presentationIntents.has(i.type));
      if (!semantic.length) {
        if (!this.options.setPresentation)
          throw new Error('Host has no writable presentation sidecar');
        return { kind: 'presentation', next, source, profile: projected.profile };
      }
      const places = looks.length > 0 || semantic.some((i) => placingIntents.has(i.type));
      if (places && this.options.commitWithPresentation)
        return {
          kind: 'both',
          guarded: this.guard(base, source, semantic, clone(next.presentation)),
          next,
          source,
          profile: projected.profile,
        };
      if (looks.length)
        throw new Error(
          'Sidecar presentation and semantic edits require separate transactions; this Host has no commitWithPresentation',
        );
      // Without the Host hook, a new node or Section takes its default place or frame.
    }
    return { kind: 'command', guarded: this.guard(base, source, intents) };
  }
  private sidecar(
    next: GraphDocument,
    source: GraphSource<S>,
    profile: GraphProfile,
  ): PresentationSidecar {
    return {
      schemaVersion: presentationSidecarSchemaVersion,
      sourceId: this.options.sourceId,
      sourceRevision: source.revision,
      adapter: { id: this.options.adapter.id, version: this.options.adapter.version },
      profile: { id: profile.id, version: profile.version },
      presentation: {
        nodes: clone(next.presentation.nodes),
        sections: this.options.adapter.sections ? clone(next.presentation.sections) : {},
      },
    };
  }
  preview(value: unknown): { proposal: AdapterProposal; projection: GraphProjection; source: S } {
    const current = this.project(),
      base = current.stamp,
      prepared = this.prepare(base, value);
    const source =
      prepared.kind === 'presentation'
        ? clone(prepared.source.content)
        : prepared.guarded.apply(clone(this.options.read().content));
    const graph =
      prepared.kind === 'presentation'
        ? prepared.next
        : prepared.kind === 'both'
          ? this.layered(source, clone(prepared.next.presentation))
          : this.layered(
              source,
              this.mode === 'sidecar' ? clone(current.graph.presentation) : undefined,
            );
    const profile = this.options.adapter.profile(source);
    assertGraph(graph, profile);
    const proposal = { id: newId('proposal'), base, intents: parseGraphIntents(value) };
    return {
      proposal,
      projection: {
        ...current,
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
    if (prepared.kind === 'command') {
      this.options.execute(prepared.guarded);
      return;
    }
    // The validated projection already applies every presentation intent of the batch.
    const sidecar = this.sidecar(prepared.next, prepared.source, prepared.profile);
    if (prepared.kind === 'both') {
      this.options.commitWithPresentation!({
        command: prepared.guarded,
        presentation: sidecar,
        base,
      });
      return;
    }
    this.options.setPresentation!(sidecar);
  }
  applyProposal(proposal: AdapterProposal) {
    this.apply(proposal.intents, proposal.base);
  }
}
