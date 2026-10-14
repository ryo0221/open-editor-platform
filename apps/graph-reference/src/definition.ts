/** Public fictional fixture, not the Workflow Framework format or a product dependency. */
import { canonicalJson, clone, deepFreeze } from '@editor-platform/artifact-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { command } from '@editor-platform/editor-core';
import {
  createGraph,
  isGraphJson,
  plainRecord,
  validGraphId,
  type JsonValue,
  type Attributes,
  type GraphAdapter,
  type GraphDocument,
  type GraphProfile,
  type GraphDiagnostic,
  type GraphIntent,
  type GraphLayout,
  type AttributeSchema,
} from '@editor-platform/structured-graph/model';
export interface ReferenceItem extends Attributes {
  id: string;
  name: string;
}
export interface ReferenceDefinition extends Attributes {
  id: string;
  version: number;
  title: string;
  guide: string;
  phases: ReferenceItem[];
  shapes: ReferenceItem[];
  gates: ReferenceItem[];
  components: ReferenceItem[];
}
export const publishedDefinition = deepFreeze<ReferenceDefinition>({
  id: 'sample-business-plan',
  version: 1,
  title: 'Fictional business plan',
  guide: 'Improve a small public sample',
  kernel: 'public-example',
  history: [{ version: 1, note: 'Original sample' }],
  unshown: { retained: 'Do not drop this field' },
  phases: [
    {
      id: 'phase-research',
      name: 'Research',
      purpose: 'Collect public facts',
      delegable: true,
      output: 'shape-notes',
      unshown: 'Retain item metadata',
    },
    {
      id: 'phase-plan',
      name: 'Plan',
      purpose: 'Describe a proposal',
      delegable: false,
      output: 'shape-plan',
    },
  ],
  shapes: [
    { id: 'shape-notes', name: 'Notes', columns: ['Fact', 'Source'] },
    { id: 'shape-plan', name: 'Plan document', columns: ['Goal', 'Estimate'] },
  ],
  gates: [
    {
      id: 'gate-check',
      name: 'Check',
      target: 'phase-plan',
      component: 'component-check',
      requiresApproval: true,
      config: { note: 'Public example', retained: 'Keep unshown nested values' },
    },
  ],
  components: [
    { id: 'component-check', name: 'Checklist', description: 'Check required headings' },
  ],
});
const collections = {
  phase: 'phases',
  shape: 'shapes',
  gate: 'gates',
  component: 'components',
} as const;
type ReferenceType = keyof typeof collections;
export function isReferenceDefinition(value: unknown): value is ReferenceDefinition {
  if (
    !isGraphJson(value) ||
    !plainRecord(value) ||
    !validGraphId(value.id) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.title !== 'string' ||
    typeof value.guide !== 'string'
  )
    return false;
  const ids = new Set<string>(['reference-definition-graph']);
  return Object.values(collections).every(
    (key) =>
      Array.isArray(value[key]) &&
      (value[key] as unknown[]).every((item) => {
        if (
          !plainRecord(item) ||
          !validGraphId(item.id) ||
          typeof item.name !== 'string' ||
          ids.has(item.id)
        )
          return false;
        ids.add(item.id);
        return true;
      }),
  );
}
export const definitionProfile: GraphProfile = {
  schemaVersion: 1,
  id: 'fictional-definition',
  version: 1,
  graph: {
    schema: {
      id: { type: 'string', readOnly: true },
      version: { type: 'number', readOnly: true },
      title: { type: 'string', required: true },
      guide: { type: 'string' },
    },
    ui: { order: ['id', 'version', 'title', 'guide'] },
  },
  nodes: {
    phase: {
      schema: {
        name: { type: 'string', required: true },
        purpose: { type: 'string', required: true },
        delegable: { type: 'boolean' },
      },
      ui: { label: 'Phase', labelField: 'name', order: ['name', 'purpose', 'delegable'] },
    },
    shape: {
      schema: {
        name: { type: 'string', required: true },
        columns: { type: 'array', items: { type: 'string' }, maxItems: 30 },
      },
      ui: { label: 'Shape', labelField: 'name' },
    },
    gate: {
      schema: {
        name: { type: 'string', required: true },
        requiresApproval: { type: 'boolean' },
        config: { type: 'object', properties: { note: { type: 'string' } } },
      },
      ui: { label: 'Gate', labelField: 'name' },
    },
    component: {
      schema: { name: { type: 'string', required: true }, description: { type: 'string' } },
      ui: { label: 'Component', labelField: 'name' },
    },
  },
  edges: {
    output: {
      schema: {},
      ui: { label: 'Output' },
      connection: {
        from: ['phase'],
        to: ['shape'],
        maxOutgoing: 1,
        allowSelf: false,
        allowParallel: false,
      },
    },
    target: {
      schema: {},
      ui: { label: 'Applies to' },
      connection: { from: ['gate'], to: ['phase'], maxOutgoing: 1, allowParallel: false },
    },
    uses: {
      schema: {},
      ui: { label: 'Uses' },
      connection: { from: ['gate'], to: ['component'], maxOutgoing: 1, allowParallel: false },
    },
    next: {
      schema: {},
      ui: { label: 'Next phase (derived)' },
      readOnly: true,
      connection: { from: ['phase'], to: ['phase'], allowCycles: false },
    },
  },
};
/** Keep ordinary derived IDs; hash long/colliding ones against the source node namespace. */
export function referenceEdgeId(type: string, sourceId: string, reserved: ReadonlySet<string>) {
  const ordinary = `${type}:${sourceId}`;
  if (validGraphId(ordinary) && !reserved.has(ordinary)) return ordinary;
  for (let salt = 0; salt <= reserved.size; salt++) {
    const id = `reference-edge:${bytesToHex(sha256(canonicalJson([type, sourceId, salt])))}`;
    if (!reserved.has(id)) return id;
  }
  throw new Error('Unsupported Definition edge identity collision');
}
export function projectDefinition(
  source: ReferenceDefinition,
  layout?: GraphLayout,
): GraphDocument {
  if (!isReferenceDefinition(source))
    throw new Error('Unsupported reference Definition; no conversion was performed');
  const graph = createGraph(definitionProfile, 'reference-definition-graph');
  graph.attributes = {
    id: source.id,
    version: source.version,
    title: source.title,
    guide: source.guide,
  };
  for (const [type, key] of Object.entries(collections))
    for (const item of source[key as keyof typeof source] as ReferenceItem[]) {
      const schema = definitionProfile.nodes[type].schema;
      graph.nodes.push({
        id: item.id,
        type,
        attributes: Object.fromEntries(
          Object.keys(schema)
            .filter((k) => Object.hasOwn(item, k))
            .map((k) => [k, clone(item[k])]),
        ),
      });
    }
  const ids = new Set(graph.nodes.map((n) => n.id));
  ids.add(graph.id);
  const requireReference = (item: ReferenceItem, key: string, targets: ReferenceItem[]) => {
    const value = item[key];
    if (value === undefined || value === null || value === '') return false;
    if (typeof value !== 'string' || !targets.some((target) => target.id === value))
      throw new Error(
        `Unresolved or unsupported Definition reference: ${item.id}.${key}; no conversion was performed`,
      );
    return true;
  };
  for (const phase of source.phases)
    if (requireReference(phase, 'output', source.shapes))
      graph.edges.push({
        id: referenceEdgeId('output', phase.id, ids),
        type: 'output',
        from: phase.id,
        to: phase.output as string,
        attributes: {},
      });
  for (const gate of source.gates)
    for (const [type, key] of [
      ['target', 'target'],
      ['uses', 'component'],
    ])
      if (requireReference(gate, key, type === 'target' ? source.phases : source.components))
        graph.edges.push({
          id: referenceEdgeId(type, gate.id, ids),
          type,
          from: gate.id,
          to: gate[key] as string,
          attributes: {},
        });
  source.phases.slice(0, -1).forEach((phase, i) =>
    graph.edges.push({
      id: referenceEdgeId('next', phase.id, ids),
      type: 'next',
      from: phase.id,
      to: source.phases[i + 1].id,
      attributes: {},
    }),
  );
  graph.layout = Object.fromEntries(
    graph.nodes.map((n, i) => [
      n.id,
      clone(layout?.[n.id] ?? { x: 40 + (i % 3) * 260, y: 40 + Math.floor(i / 3) * 160 }),
    ]),
  );
  return graph;
}
function locate(source: ReferenceDefinition, id: string) {
  for (const [type, key] of Object.entries(collections) as [
    ReferenceType,
    (typeof collections)[ReferenceType],
  ][]) {
    const item = source[key].find((x) => x.id === id);
    if (item) return { type, key, item };
  }
  throw new Error('Definition element is missing');
}
export type ReferenceValidator = (source: ReferenceDefinition) => GraphDiagnostic[];
/** Host injection stands in for its existing schema/parseDefinition validator. */
export const validateReference: ReferenceValidator = (source) =>
  source.phases
    .filter((phase) => typeof phase.purpose !== 'string' || !phase.purpose.trim())
    .map((phase) => ({
      scope: 'node',
      elementId: phase.id,
      path: ['purpose'],
      code: 'reference-purpose',
      message: 'Enter a purpose before publishing this Definition',
      severity: 'error',
      blocking: false,
    }));
function hasUnmappedChildren(value: JsonValue | undefined, schema: AttributeSchema): boolean {
  if (plainRecord(value) && schema.type === 'object')
    return Object.entries(value).some(
      ([key, child]) =>
        !Object.hasOwn(schema.properties ?? {}, key) ||
        hasUnmappedChildren(child as JsonValue, schema.properties![key]),
    );
  if (Array.isArray(value) && schema.items)
    return value.some((child) => hasUnmappedChildren(child, schema.items!));
  return false;
}
function mergeDeclared(
  previous: JsonValue | undefined,
  value: JsonValue,
  schema: AttributeSchema,
): JsonValue {
  if (plainRecord(previous) && plainRecord(value) && schema.type === 'object') {
    const next = clone(previous);
    for (const [key, child] of Object.entries(value)) {
      const field = schema.properties?.[key];
      if (!field) {
        if (!Object.hasOwn(previous, key) || canonicalJson(previous[key]) !== canonicalJson(child))
          throw new Error(
            'This object contains undeclared data; only declared children can be edited',
          );
      } else
        next[key] = mergeDeclared(
          previous[key] as JsonValue | undefined,
          child as JsonValue,
          field,
        );
    }
    return next as JsonValue;
  }
  if (hasUnmappedChildren(previous, schema))
    throw new Error('Cannot clear this object: undeclared child data must be retained');
  return clone(value);
}
export function createDefinitionAdapter(
  validate: ReferenceValidator = validateReference,
): GraphAdapter<ReferenceDefinition> {
  return {
    id: 'fictional-definition-adapter',
    version: 1,
    layoutMode: 'sidecar',
    profile: () => definitionProfile,
    project: projectDefinition,
    diagnostics: validate,
    prepare(source, intents: GraphIntent[]) {
      const base = canonicalJson(source),
        fixed = clone(intents);
      return command('reference.definition-edit', 'Edit reference Definition', (current) => {
        if (!isReferenceDefinition(current) || canonicalJson(current) !== base)
          throw new Error('Stale or invalid Definition source');
        const next = clone(current);
        for (const intent of fixed) {
          if (intent.type === 'move-node')
            throw new Error('Definition layout belongs to the Host sidecar');
          if (intent.type === 'set-attribute' || intent.type === 'remove-attribute') {
            if (intent.path.length !== 1 || intent.scope === 'edge')
              throw new Error('This field has no safe inverse mapping');
            const key = intent.path[0],
              entry = intent.scope === 'graph' ? undefined : locate(next, intent.id),
              item = entry?.item ?? next,
              schema = entry
                ? definitionProfile.nodes[entry.type].schema
                : definitionProfile.graph.schema,
              field = schema[key];
            if (!field) throw new Error('This undeclared field has no safe inverse mapping');
            if (['id', 'version'].includes(key))
              throw new Error(
                'Published identity/version is read only; publish a new draft version in the Host',
              );
            if (intent.type === 'remove-attribute') {
              if (hasUnmappedChildren(item[key], field))
                throw new Error('Cannot clear this object: undeclared child data must be retained');
              delete item[key];
            } else item[key] = mergeDeclared(item[key], intent.value, field);
          } else if (intent.type === 'add-node') {
            const type = intent.node.type as ReferenceType,
              key = collections[type];
            if (!key || projectDefinition(next).nodes.some((n) => n.id === intent.node.id))
              throw new Error('Unknown or duplicate Definition node');
            next[key].push({
              ...clone(intent.node.attributes),
              id: intent.node.id,
              name: String(intent.node.attributes.name ?? 'New item'),
            });
          } else if (intent.type === 'delete-node') {
            // Ordered nodes have derived edges: use the explicit source operation instead.
            const entry = locate(next, intent.id);
            if (entry.type === 'phase')
              throw new Error('Delete an ordered phase explicitly in the Definition Host');
            const refs = projectDefinition(next).edges.filter(
              (e) => e.from === intent.id || e.to === intent.id,
            );
            if (refs.length && !intent.cascade)
              throw new Error('Confirm Definition reference updates');
            next[entry.key] = next[entry.key].filter((x) => x.id !== intent.id);
            for (const phase of next.phases) if (phase.output === intent.id) delete phase.output;
            for (const gate of next.gates) {
              if (gate.target === intent.id) delete gate.target;
              if (gate.component === intent.id) delete gate.component;
            }
          } else {
            const projected = projectDefinition(next),
              edge =
                intent.type === 'add-edge'
                  ? intent.edge
                  : projected.edges.find((e) => e.id === intent.id);
            if (!edge || edge.type === 'next')
              throw new Error('Derived next-phase edges are read only; use explicit phase reorder');
            const entry = locate(next, edge.from),
              key =
                edge.type === 'output' ? 'output' : edge.type === 'uses' ? 'component' : 'target';
            if (
              intent.type === 'add-edge' &&
              (Object.keys(edge.attributes).length || entry.item[key])
            )
              throw new Error(
                'Reference already connected or edge attributes have no inverse mapping',
              );
            if (
              intent.type === 'add-edge' &&
              edge.id !==
                referenceEdgeId(
                  edge.type,
                  edge.from,
                  new Set([projected.id, ...projected.nodes.map((node) => node.id)]),
                )
            )
              throw new Error('Definition relationships require their canonical edge ID');
            if (intent.type === 'reconnect-edge' && intent.from !== edge.from)
              throw new Error('Reference source identity cannot change; disconnect then connect');
            if (intent.type === 'delete-edge') delete entry.item[key];
            else entry.item[key] = intent.type === 'reconnect-edge' ? intent.to : edge.to;
          }
        }
        if (!isReferenceDefinition(next))
          throw new Error('Definition edit would corrupt its source');
        projectDefinition(next); // Mapped references must never disappear silently.
        validate(next); // Existing domain validator produces revision-bound semantic diagnostics.
        return next;
      });
    },
  };
}
export function reorderReferencePhase(id: string, beforeId: string | null) {
  return command<ReferenceDefinition>(
    'reference.reorder-phase',
    'Reorder phase explicitly',
    (current) => {
      const item = current.phases.find((p) => p.id === id);
      if (!item) throw new Error('Phase is missing');
      const phases = current.phases.filter((p) => p.id !== id),
        index = beforeId === null ? phases.length : phases.findIndex((p) => p.id === beforeId);
      if (index < 0) throw new Error('Target phase is missing');
      phases.splice(index, 0, item);
      return { ...current, phases };
    },
  );
}
