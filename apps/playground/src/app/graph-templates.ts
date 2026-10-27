import {
  arrangeGraph,
  createGraph,
  graphCommand,
  createRelationGraph,
  relationProfile,
  type GraphDocument,
  type GraphNodeType,
  type GraphProfile,
  type GraphSectionType,
} from '@editor-platform/structured-graph/model';

/**
 * Playground diagram vocabulary (#396 Phase 3). The Graph package stays domain-neutral: the
 * words for environments, layers, services and flow steps live only in this Host Profile and
 * its templates.
 */
const fields = {
  name: { label: 'Name' },
  description: { label: 'Description' },
  technology: { label: 'Technology' },
};
const node = (
  label: string,
  group: string,
  shape: NonNullable<GraphNodeType['ui']>['shape'],
  fill: string,
): GraphNodeType => ({
  schema: {
    name: { type: 'string', required: true },
    description: { type: 'string' },
    technology: { type: 'string' },
  },
  ui: {
    label,
    group,
    shape,
    style: { fill },
    labelField: 'name',
    order: ['name', 'description', 'technology'],
    fields,
  },
});
const section = (
  label: string,
  fill: string,
  contains?: GraphSectionType['contains'],
): GraphSectionType => ({
  schema: { name: { type: 'string', required: true }, description: { type: 'string' } },
  ui: {
    label,
    labelField: 'name',
    order: ['name', 'description'],
    fields: { name: fields.name, description: fields.description },
    style: { fill },
  },
  ...(contains ? { contains } : {}),
});
const edge = (label: string, field: string, fieldLabel: string, dash?: number[]) => ({
  schema: { [field]: { type: 'string' as const } },
  ui: {
    label,
    labelField: field,
    order: [field],
    fields: { [field]: { label: fieldLabel } },
    ...(dash ? { edgeStyle: { dash } } : {}),
  },
  connection: { allowSelf: false, allowParallel: true, allowCycles: true },
});

export const diagramProfile: GraphProfile = {
  schemaVersion: 2,
  id: 'diagrams',
  version: 1,
  graph: {
    schema: { title: { type: 'string', required: true }, notes: { type: 'string' } },
    ui: {
      order: ['title', 'notes'],
      fields: { title: { label: 'Title' }, notes: { label: 'Notes' } },
    },
  },
  nodes: {
    user: node('User', 'Architecture', 'ellipse', '#ede9fe'),
    app: node('App', 'Architecture', 'rounded-rectangle', '#dbeafe'),
    gateway: node('Gateway', 'Architecture', 'hexagon', '#fef3c7'),
    service: node('Service', 'Architecture', 'rounded-rectangle', '#ffffff'),
    database: node('Database', 'Architecture', 'cylinder', '#dcfce7'),
    queue: node('Queue', 'Architecture', 'rectangle', '#fef3c7'),
    external: node('External service', 'Architecture', 'cloud', '#e2e8f0'),
    start: node('Start / end', 'Flow', 'ellipse', '#dcfce7'),
    step: node('Step', 'Flow', 'rectangle', '#ffffff'),
    decision: node('Decision', 'Flow', 'diamond', '#fef3c7'),
    record: node('Record', 'Flow', 'cylinder', '#e2e8f0'),
    team: node('Team', 'Organization', 'rounded-rectangle', '#dbeafe'),
    person: node('Person', 'Organization', 'ellipse', '#ffffff'),
  },
  edges: {
    connects: edge('Connects to', 'protocol', 'Protocol'),
    flow: edge('Then', 'label', 'Label'),
    reports: edge('Reports to', 'label', 'Label', [6, 4]),
  },
  sections: {
    environment: section('Environment', '#f8fafc', { sections: ['network', 'layer'] }),
    network: section('Network', '#eff6ff', { sections: ['network', 'layer'] }),
    layer: section('Layer', '#ffffff', { sections: [] }),
    lane: section('Lane', '#f8fafc', { sections: [] }),
    unit: section('Unit', '#f8fafc'),
  },
};

type Spec = {
  sections?: [id: string, type: string, name: string, parentId?: string][];
  nodes: [id: string, type: string, name: string, sectionId?: string, technology?: string][];
  edges: [from: string, to: string, type: string, label?: string][];
};
/** Builds a diagram with stable IDs, laid out by the same Section-aware arrange as the toolbar. */
function build(title: string, spec: Spec): GraphDocument {
  const g = createGraph({ id: diagramProfile.id, version: diagramProfile.version });
  g.attributes = { title };
  g.sections = (spec.sections ?? []).map(([id, type, name, parentId]) => ({
    id,
    type,
    attributes: { name },
    ...(parentId ? { parentId } : {}),
  }));
  g.presentation.sections = Object.fromEntries(
    g.sections.map((s, i) => [s.id, { x: 40 + 20 * i, y: 40 + 20 * i, width: 240, height: 160 }]),
  );
  g.nodes = spec.nodes.map(([id, type, name, sectionId, technology]) => ({
    id,
    type,
    attributes: { name, ...(technology ? { technology } : {}) },
    ...(sectionId ? { sectionId } : {}),
  }));
  g.edges = spec.edges.map(([from, to, type, label], i) => ({
    id: `${from}-${to}-${i + 1}`,
    type,
    from,
    to,
    attributes: label ? { [type === 'connects' ? 'protocol' : 'label']: label } : {},
  }));
  const arranged = arrangeGraph(g);
  return arranged.length ? graphCommand(diagramProfile, arranged).apply(g) : g;
}

export const graphTemplates = [
  {
    id: 'relations',
    label: 'Relation map',
    profile: relationProfile,
    create: createRelationGraph,
  },
  {
    id: 'architecture',
    label: 'System architecture',
    profile: diagramProfile,
    create: () =>
      build('System architecture', {
        sections: [
          ['production', 'environment', 'Production'],
          ['frontend', 'layer', 'Frontend', 'production'],
          ['backend', 'layer', 'Backend', 'production'],
        ],
        nodes: [
          ['user', 'user', 'User'],
          ['web', 'app', 'Web app', 'frontend', 'React'],
          ['api', 'service', 'API server', 'backend', 'Node.js'],
          ['db', 'database', 'Database', 'backend', 'PostgreSQL'],
          ['cloud', 'external', 'External cloud'],
        ],
        edges: [
          ['user', 'web', 'connects', 'HTTPS'],
          ['web', 'api', 'connects', 'REST'],
          ['api', 'db', 'connects', 'SQL'],
          ['api', 'cloud', 'connects', 'HTTPS'],
        ],
      }),
  },
  {
    id: 'flow',
    label: 'Flowchart',
    profile: diagramProfile,
    create: () =>
      build('Flowchart', {
        nodes: [
          ['start', 'start', 'Start'],
          ['step', 'step', 'Receive request'],
          ['check', 'decision', 'Approved?'],
          ['done', 'start', 'End'],
        ],
        edges: [
          ['start', 'step', 'flow'],
          ['step', 'check', 'flow'],
          ['check', 'done', 'flow', 'Yes'],
          ['check', 'step', 'flow', 'No'],
        ],
      }),
  },
  {
    id: 'blank',
    label: 'Blank diagram',
    profile: diagramProfile,
    create: () => build('Diagram', { nodes: [], edges: [] }),
  },
] as const;
export type GraphTemplateId = (typeof graphTemplates)[number]['id'];

/** Every Graph Profile this Playground Host registers. */
export const graphProfiles: readonly GraphProfile[] = [relationProfile, diagramProfile];
/** The registered Profile a Graph names, or undefined when this Host does not know it. */
export function graphProfileFor(graph: Pick<GraphDocument, 'profile'>): GraphProfile | undefined {
  return graphProfiles.find(
    (p) => p.id === graph.profile.id && p.version === graph.profile.version,
  );
}
