import { clone } from '@editor-platform/artifact-core';
import {
  type Attributes,
  type GraphAdapter,
  type GraphDiagnostic,
  type GraphDocument,
  type GraphEdge,
  type GraphIntent,
  type GraphNode,
  type GraphNodePresentations,
  type GraphProfile,
  type GraphSectionPresentation,
  type PresentationSidecar,
} from '@editor-platform/structured-graph/model';
import {
  owdElementKey,
  owdElements,
  parseOwdElementKey,
  type OwdElementKind,
  type OwdElementRef,
} from './ids';
import {
  cycleDiagnostics,
  structureDiagnostics,
  type WorkflowDefinitionDiagnostic,
} from './diagnostics';
import { mapCheckResults, type WorkflowDefinitionCheck } from './check';
import {
  applyWorkflowDefinitionIntents,
  workflowDefinitionCommand,
  type WorkflowDefinitionIntent,
} from './commands';
import { readOwdDefinition } from './read';
import { type OwdDefinition, type OwdJson, type OwdRecord } from './types';

const ro = { type: 'string', readOnly: true } as const;
const text = (required = true) => ({ type: 'string' as const, ...(required ? { required } : {}) });
/**
 * The flow view's Profile (design §4). Node and Section IDs carry the kind (`phase:concept`).
 * `after` keeps the default that allows cycles: a cyclic draft is shown with a diagnostic, never
 * refused by the Graph.
 */
export const owdGraphProfile: GraphProfile = {
  schemaVersion: 2,
  id: 'owd-workflow-definition',
  version: 1,
  graph: {
    schema: {
      id: ro,
      version: text(),
      title: text(),
      purpose: text(),
      strictCites: { type: 'boolean' },
    },
    ui: {
      order: ['id', 'version', 'title', 'purpose', 'strictCites'],
      fields: {
        id: { label: '定義の ID' },
        version: { label: '版' },
        title: { label: '題' },
        purpose: { label: '目的' },
        strictCites: { label: '規則に無い引用を断る' },
      },
    },
  },
  nodes: {
    phase: {
      schema: { id: ro, name: text(), purpose: text(), icon: text(false) },
      ui: {
        label: '工程',
        labelField: 'name',
        order: ['id', 'name', 'purpose', 'icon'],
        fields: {
          id: { label: 'ID' },
          name: { label: '名前' },
          purpose: { label: '目的' },
          icon: { label: 'アイコン' },
        },
        shape: 'rounded-rectangle',
        group: '工程',
      },
    },
    deliverable: {
      schema: { id: ro, name: text(), form: text() },
      ui: {
        label: '成果物',
        labelField: 'name',
        order: ['id', 'name', 'form'],
        fields: { id: { label: 'ID' }, name: { label: '名前' }, form: { label: '表現形態' } },
        shape: 'rectangle',
        group: '成果物と条件',
      },
    },
    acceptance: {
      schema: {
        id: ro,
        text: text(),
        checkedBy: { type: 'enum', enum: ['人', 'AI'], required: true },
      },
      ui: {
        label: '達成条件',
        labelField: 'text',
        order: ['id', 'text', 'checkedBy'],
        fields: { id: { label: 'ID' }, text: { label: '条件' }, checkedBy: { label: '確かめる' } },
        shape: 'hexagon',
        group: '成果物と条件',
      },
    },
    role: {
      schema: { id: ro, name: text(), text: text(false) },
      ui: {
        label: '役割',
        labelField: 'name',
        order: ['id', 'name', 'text'],
        fields: { id: { label: 'ID' }, name: { label: '名前' }, text: { label: '説明' } },
        shape: 'ellipse',
        group: '成果物と条件',
      },
    },
  },
  edges: {
    after: {
      schema: {},
      ui: { label: '先に終える' },
      // A phase after itself is a cycle: shown by the non-blocking cycle diagnostic, not refused,
      // so a draft that has one still opens in the flow view.
      connection: { from: ['phase'], to: ['phase'], allowSelf: true, allowParallel: false },
    },
    makes: {
      schema: {},
      ui: { label: '作る' },
      connection: { from: ['phase'], to: ['deliverable'], allowParallel: false },
    },
    'ends-with': {
      schema: {},
      ui: { label: '終える条件' },
      connection: { from: ['phase'], to: ['acceptance'], allowParallel: false },
    },
    checks: {
      schema: {},
      ui: { label: '確かめる成果物' },
      connection: {
        from: ['acceptance'],
        to: ['deliverable'],
        maxOutgoing: 1,
        allowParallel: false,
      },
    },
    uses: {
      schema: {},
      ui: { label: 'もとにする' },
      connection: {
        from: ['deliverable'],
        to: ['deliverable'],
        // A deliverable that uses itself is a draft to repair, not a reason to close the view.
        allowSelf: true,
        allowParallel: false,
      },
    },
    'approved-by': {
      schema: {},
      ui: { label: '確かめる役割' },
      connection: { from: ['acceptance'], to: ['role'], allowParallel: false },
    },
  },
  sections: {
    section: {
      schema: { id: ro, name: text(), icon: text(false) },
      ui: { label: 'まとまり', labelField: 'name', order: ['id', 'name', 'icon'] },
      contains: { nodes: ['phase'], sections: [] },
    },
  },
};
const nodeKinds = ['phase', 'deliverable', 'acceptance', 'role'] as const;
type NodeKind = (typeof nodeKinds)[number];
/** Attributes of an element that the Profile shows, only where they have the declared type. */
function attributesOf(kind: NodeKind | 'section', record: OwdRecord): Attributes {
  const schema =
    kind === 'section'
      ? owdGraphProfile.sections.section.schema
      : owdGraphProfile.nodes[kind].schema;
  const out: Attributes = {};
  for (const [key, s] of Object.entries(schema)) {
    const value = record[key];
    if (
      (s.type === 'string' && typeof value === 'string') ||
      (s.type === 'enum' && s.enum!.includes(value as string))
    )
      out[key] = value as string;
  }
  return out;
}
/** The projected Graph's ID; definition-level diagnostics are addressed to it. */
const owdGraphId = (def: OwdDefinition) => `owd:${String(def.id)}`.slice(0, 512);
const edgeId = (type: string, from: string, to: string) => `${type}|${from}|${to}`;
function parseEdgeId(id: string) {
  const [type, from, to, ...rest] = id.split('|');
  const a = parseOwdElementKey(from),
    b = parseOwdElementKey(to);
  return rest.length || !a || !b ? undefined : { type, from: a, to: b };
}
/** Default places: one row per kind, in list order. Saved sidecar places replace them. */
const rows: Record<NodeKind, number> = { phase: 80, deliverable: 320, acceptance: 520, role: 720 };
const defaultPlace = (kind: NodeKind, index: number) => ({ x: 40 + index * 260, y: rows[kind] });

/** Projects the definition as a Graph (design §4). Duplicate IDs show their first element only. */
export function projectOwdGraph(
  definition: OwdDefinition,
  presentation?: GraphNodePresentations,
): GraphDocument {
  const def = readOwdDefinition(definition);
  const nodes: GraphNode[] = [],
    edges: GraphEdge[] = [],
    places: GraphNodePresentations = {},
    taken = new Set<string>();
  const sectionOf = new Map<string, string>();
  const sections = owdElements(def, 'section').filter((s) => {
    const key = owdElementKey({ kind: 'section', id: s.id as string });
    if (taken.has(key)) return false;
    taken.add(key);
    for (const p of (s.phases as string[]) ?? []) if (!sectionOf.has(p)) sectionOf.set(p, key);
    return true;
  });
  for (const kind of nodeKinds)
    owdElements(def, kind).forEach((record, index) => {
      const id = owdElementKey({ kind, id: record.id as string });
      if (taken.has(id)) return;
      taken.add(id);
      const sectionId = kind === 'phase' ? sectionOf.get(record.id as string) : undefined;
      nodes.push({
        id,
        type: kind,
        attributes: attributesOf(kind, record),
        ...(sectionId ? { sectionId } : {}),
      });
      places[id] = presentation?.[id] ?? defaultPlace(kind, index);
    });
  const has = (key: string) => taken.has(key);
  const edge = (type: string, from: OwdElementRef, to: OwdElementRef) => {
    const a = owdElementKey(from),
      b = owdElementKey(to),
      id = edgeId(type, a, b);
    if (!has(a) || !has(b) || edges.some((e) => e.id === id)) return;
    edges.push({ id, type, from: a, to: b, attributes: {} });
  };
  // Like the nodes, relations come from the first element of a duplicated ID only.
  const firsts = (kind: OwdElementKind) => {
    const seen = new Set<string>();
    return owdElements(def, kind).filter((e) => {
      if (seen.has(e.id as string)) return false;
      seen.add(e.id as string);
      return true;
    });
  };
  for (const p of firsts('phase')) {
    const self = { kind: 'phase' as const, id: p.id as string };
    for (const a of p.after as string[]) edge('after', { kind: 'phase', id: a }, self);
    for (const d of p.deliverables as string[]) edge('makes', self, { kind: 'deliverable', id: d });
    for (const a of p.acceptance as string[])
      edge('ends-with', self, { kind: 'acceptance', id: a });
  }
  for (const d of firsts('deliverable'))
    for (const u of (d.uses as string[]) ?? [])
      edge('uses', { kind: 'deliverable', id: d.id as string }, { kind: 'deliverable', id: u });
  for (const a of firsts('acceptance')) {
    const self = { kind: 'acceptance' as const, id: a.id as string };
    if (typeof a.target === 'string' && a.target)
      edge('checks', self, { kind: 'deliverable', id: a.target });
    for (const r of ((a.approvers as OwdRecord | undefined)?.roles as string[]) ?? [])
      edge('approved-by', self, { kind: 'role', id: r });
  }
  // A Section's default frame surrounds its phases where they are drawn.
  const frames: Record<string, GraphSectionPresentation> = {};
  sections.forEach((s, index) => {
    const key = owdElementKey({ kind: 'section', id: s.id as string });
    const inside = nodes.filter((n) => n.sectionId === key).map((n) => places[n.id]);
    frames[key] = inside.length
      ? {
          x: Math.min(...inside.map((p) => p.x)) - 20,
          y: Math.min(...inside.map((p) => p.y)) - 50,
          width: Math.max(...inside.map((p) => p.x)) - Math.min(...inside.map((p) => p.x)) + 240,
          height: Math.max(...inside.map((p) => p.y)) - Math.min(...inside.map((p) => p.y)) + 150,
        }
      : { x: 40 + index * 260, y: -200, width: 220, height: 120 };
  });
  const graphAttributes: Attributes = {};
  for (const key of ['id', 'version', 'title', 'purpose'])
    if (typeof def[key] === 'string') graphAttributes[key] = def[key] as string;
  if (def.strictCites === true) graphAttributes.strictCites = true;
  return {
    schemaVersion: 3,
    id: owdGraphId(def),
    profile: { id: owdGraphProfile.id, version: owdGraphProfile.version },
    attributes: graphAttributes,
    nodes,
    edges,
    sections: sections.map((s) => ({
      id: owdElementKey({ kind: 'section', id: s.id as string }),
      type: 'section',
      attributes: attributesOf('section', s),
    })),
    presentation: { nodes: places, sections: frames },
  };
}

const refOf = (key: string, kinds: readonly string[]) => {
  const ref = parseOwdElementKey(key);
  if (!ref || !kinds.includes(ref.kind))
    throw new Error(`${key} is not an element of this definition`);
  return ref;
};
/** The reference field an edge type stands for, on the edge's owner. */
function referenceEdit(
  def: OwdDefinition,
  type: string,
  from: OwdElementRef,
  to: OwdElementRef,
  change: 'add' | 'remove',
  /** With `remove`: write this ID in the entry's place instead, keeping the list order. */
  replaceWith?: string,
): WorkflowDefinitionIntent {
  const find = (ref: OwdElementRef) => {
    const found = owdElements(def, ref.kind).find((e) => e.id === ref.id);
    if (!found) throw new Error(`${ref.kind} ${ref.id} does not exist`);
    return found;
  };
  const listEdit = (owner: OwdElementRef, field: string, value: string, nested?: 'approvers') => {
    const record = find(owner);
    const current = (
      nested ? ((record.approvers as OwdRecord | undefined)?.roles ?? []) : (record[field] ?? [])
    ) as string[];
    let next: string[];
    if (change === 'add') next = [...current, value];
    else if (replaceWith !== undefined) next = current.map((v) => (v === value ? replaceWith : v));
    else next = current.filter((v) => v !== value);
    if (nested) {
      const approvers = clone(
        (record.approvers as OwdRecord | undefined) ?? { roles: [] },
      ) as OwdRecord;
      approvers.roles = next;
      return {
        type: 'set-fields' as const,
        kind: owner.kind,
        id: owner.id,
        fields: { approvers: next.length ? (approvers as OwdJson) : null },
      };
    }
    return {
      type: 'set-fields' as const,
      kind: owner.kind,
      id: owner.id,
      fields: { [field]: next.length || field !== 'uses' ? next : null },
    };
  };
  switch (type) {
    case 'after':
      return listEdit(to, 'after', from.id);
    case 'makes':
      return listEdit(from, 'deliverables', to.id);
    case 'ends-with':
      return listEdit(from, 'acceptance', to.id);
    case 'uses':
      return listEdit(from, 'uses', to.id);
    case 'approved-by':
      return listEdit(from, 'approvers', to.id, 'approvers');
    case 'checks':
      if (change === 'remove')
        throw new Error(
          'An acceptance condition always checks one deliverable; connect it to another one instead',
        );
      return { type: 'set-fields', kind: 'acceptance', id: from.id, fields: { target: to.id } };
    default:
      throw new Error(`Unknown relation ${type}`);
  }
}
/** Adds the phase to the section, keeping members in phase order as OWD sections require. */
function joinSection(
  def: OwdDefinition,
  out: WorkflowDefinitionIntent[],
  phase: string,
  sectionId: string,
) {
  const section = refOf(sectionId, ['section']);
  const current = applyAll(def, out);
  const record = owdElements(current, 'section').find((s) => s.id === section.id);
  if (!record) throw new Error(`section ${section.id} does not exist`);
  const order = owdElements(current, 'phase').map((p) => p.id as string);
  const phases = [...(record.phases as string[]), phase].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );
  out.push({ type: 'set-fields', kind: 'section', id: section.id, fields: { phases } });
}
/** Graph intents as workflow definition intents (design §4). Presentation stays in the sidecar. */
export function owdIntentsFromGraph(
  definition: OwdDefinition,
  intents: readonly GraphIntent[],
): WorkflowDefinitionIntent[] {
  const def = readOwdDefinition(definition);
  const out: WorkflowDefinitionIntent[] = [];
  // Relations added or moved earlier in the batch, by the ID the batch uses for them.
  const moved = new Map<string, NonNullable<ReturnType<typeof parseEdgeId>>>();
  const edgeOf = (id: string) => moved.get(id) ?? parseEdgeId(id);
  for (const intent of intents)
    switch (intent.type) {
      case 'add-node': {
        const ref = refOf(intent.node.id, nodeKinds);
        if (ref.kind !== intent.node.type) throw new Error('The node ID names another kind');
        const fields: OwdRecord = {};
        for (const [key, value] of Object.entries(intent.node.attributes))
          if (key !== 'id' && value !== '' && value !== null) fields[key] = value as OwdJson;
        out.push({ type: 'add', kind: ref.kind, id: ref.id, fields });
        // A phase created inside a section joins it in the same command.
        if (intent.node.sectionId !== undefined) {
          if (ref.kind !== 'phase') throw new Error('Only phases belong to sections');
          joinSection(def, out, ref.id, intent.node.sectionId);
        }
        break;
      }
      case 'add-section': {
        const ref = refOf(intent.section.id, ['section']);
        const fields: OwdRecord = {};
        for (const [key, value] of Object.entries(intent.section.attributes))
          if (key !== 'id' && value !== '' && value !== null) fields[key] = value as OwdJson;
        out.push({ type: 'add', kind: 'section', id: ref.id, fields });
        break;
      }
      case 'set-attribute':
      case 'remove-attribute': {
        if (intent.path.length !== 1) throw new Error('Edit this field in the lists');
        const key = intent.path[0];
        const value =
          intent.type === 'remove-attribute'
            ? null
            : key === 'strictCites'
              ? intent.value === true
                ? true
                : null
              : (intent.value as OwdJson);
        if (key === 'id') throw new Error('Change an ID with the ID command');
        if (intent.scope === 'graph')
          out.push({ type: 'set-definition', fields: { [key]: value } });
        else if (intent.scope === 'node' || intent.scope === 'section') {
          const ref = refOf(intent.id, intent.scope === 'node' ? nodeKinds : ['section']);
          out.push({ type: 'set-fields', kind: ref.kind, id: ref.id, fields: { [key]: value } });
        } else throw new Error('Relations have no fields');
        break;
      }
      case 'delete-node': {
        const ref = refOf(intent.id, nodeKinds);
        out.push({ type: 'delete', kind: ref.kind, id: ref.id, cascade: intent.cascade });
        break;
      }
      case 'delete-section': {
        const ref = refOf(intent.id, ['section']);
        out.push({ type: 'delete', kind: 'section', id: ref.id });
        break;
      }
      case 'add-edge': {
        const from = refOf(intent.edge.from, nodeKinds),
          to = refOf(intent.edge.to, nodeKinds);
        out.push(referenceEdit(applyAll(def, out), intent.edge.type, from, to, 'add'));
        moved.set(intent.edge.id, { type: intent.edge.type, from, to });
        break;
      }
      case 'delete-edge': {
        const parsed = edgeOf(intent.id);
        if (!parsed) throw new Error('Unknown relation');
        out.push(referenceEdit(applyAll(def, out), parsed.type, parsed.from, parsed.to, 'remove'));
        moved.delete(intent.id);
        break;
      }
      case 'reconnect-edge': {
        const parsed = edgeOf(intent.id);
        if (!parsed) throw new Error('Unknown relation');
        const from = refOf(intent.from, nodeKinds),
          to = refOf(intent.to, nodeKinds);
        const current = applyAll(def, out);
        if (parsed.type === 'checks') {
          // An acceptance needs its target, so the edge can move to another deliverable only.
          if (from.id !== parsed.from.id)
            throw new Error('A check stays with its acceptance; change the target instead');
          out.push({
            type: 'set-fields',
            kind: 'acceptance',
            id: from.id,
            fields: { target: to.id },
          });
        } else if (
          // The owner of the reference stays: replace the entry in place, keeping its order.
          (parsed.type === 'after' && to.id === parsed.to.id) ||
          (parsed.type !== 'after' && from.id === parsed.from.id)
        )
          out.push(
            referenceEdit(
              current,
              parsed.type,
              parsed.from,
              parsed.to,
              'remove',
              parsed.type === 'after' ? from.id : to.id,
            ),
          );
        else {
          out.push(referenceEdit(current, parsed.type, parsed.from, parsed.to, 'remove'));
          out.push(referenceEdit(applyAll(def, out), parsed.type, from, to, 'add'));
        }
        moved.set(intent.id, { type: parsed.type, from, to });
        break;
      }
      case 'set-node-section': {
        const phase = refOf(intent.id, ['phase']);
        const current = applyAll(def, out);
        for (const s of owdElements(current, 'section'))
          if ((s.phases as string[]).includes(phase.id)) {
            out.push({
              type: 'set-fields',
              kind: 'section',
              id: s.id as string,
              fields: { phases: (s.phases as string[]).filter((p) => p !== phase.id) },
            });
          }
        if (intent.sectionId !== null) joinSection(def, out, phase.id, intent.sectionId);
        break;
      }
      case 'set-section-parent':
        throw new Error('Sections of a workflow definition do not nest');
      default:
        throw new Error('Presentation belongs to the Host sidecar');
    }
  return out;
}
const applyAll = (def: OwdDefinition, intents: WorkflowDefinitionIntent[]) =>
  intents.length ? applyWorkflowDefinitionIntents(def, intents) : def;

export interface OwdGraphAdapterOptions {
  /** The Host's OWD check; without it the diagnostics say that this Host does not check. */
  check?: WorkflowDefinitionCheck;
}
const graphDiagnostic =
  (graphId: string) =>
  (d: WorkflowDefinitionDiagnostic): GraphDiagnostic => {
    const key = d.target && owdElementKey(d.target);
    const scope = !d.target
      ? 'graph'
      : d.target.kind === 'section'
        ? 'section'
        : nodeKinds.includes(d.target.kind as NodeKind)
          ? 'node'
          : 'graph';
    return {
      scope,
      elementId: scope === 'graph' ? graphId : key!,
      path: d.path.map(String),
      code: d.code,
      ...(d.args ? { args: d.args } : {}),
      message:
        scope === 'graph' && d.target ? `${d.target.kind} ${d.target.id}: ${d.message}` : d.message,
      severity: d.blocking ? 'error' : 'warning',
      blocking: false,
    };
  };
/** Every diagnostic of the definition: structure, cycles and the Host's OWD check. */
export function workflowDefinitionDiagnostics(
  definition: OwdDefinition,
  check?: WorkflowDefinitionCheck,
): WorkflowDefinitionDiagnostic[] {
  const def = readOwdDefinition(definition);
  const checked: WorkflowDefinitionDiagnostic[] = check
    ? mapCheckResults(def, check(clone(def)))
    : [
        {
          path: [],
          code: 'no-check',
          message: 'This Host does not check workflow definitions',
          source: 'check',
          blocking: false,
        },
      ];
  return [...structureDiagnostics(def), ...cycleDiagnostics(def), ...checked];
}
/** The flow view's adapter (design §3). Presentation, including Section frames, is in a sidecar. */
export function createOwdGraphAdapter(
  options: OwdGraphAdapterOptions = {},
): GraphAdapter<OwdDefinition> {
  return {
    id: 'owd-workflow-definition',
    version: 1,
    presentationMode: 'sidecar',
    sections: true,
    profile: () => owdGraphProfile,
    project: (source, presentation) => projectOwdGraph(source, presentation),
    prepare: (source, intents) =>
      workflowDefinitionCommand(owdIntentsFromGraph(source, intents), {
        label: 'Edit workflow definition',
        base: source,
      }),
    diagnostics: (source) =>
      workflowDefinitionDiagnostics(source, options.check).map(graphDiagnostic(owdGraphId(source))),
  };
}
export const owdGraphAdapter = createOwdGraphAdapter();
/**
 * The sidecar with the places and frames of renamed elements moved to their new IDs (phases,
 * deliverables, acceptance and roles are nodes, sections are frames). `undefined` when no saved
 * place changes, so the edit needs no sidecar write. With `keep`, the old entries stay too: a Host
 * that writes the sidecar as a separate Undo step keeps the place when the rename alone is undone.
 */
export function owdRenamedPresentation(
  sidecar: PresentationSidecar | undefined,
  intents: readonly WorkflowDefinitionIntent[],
  keep = false,
): PresentationSidecar | undefined {
  if (!sidecar?.presentation) return undefined;
  const next = clone(sidecar);
  let changed = false;
  for (const i of intents) {
    if (i.type !== 'rename-id' || i.id === i.to) continue;
    const maps =
      i.kind === 'section'
        ? [next.presentation.sections]
        : (nodeKinds as readonly string[]).includes(i.kind)
          ? [next.presentation.nodes]
          : [];
    for (const map of maps as Record<string, unknown>[]) {
      const from = owdElementKey({ kind: i.kind, id: i.id }),
        to = owdElementKey({ kind: i.kind, id: i.to });
      if (!map || !Object.hasOwn(map, from)) continue;
      map[to] = map[from];
      if (!keep) delete map[from];
      changed = true;
    }
  }
  return changed ? next : undefined;
}
