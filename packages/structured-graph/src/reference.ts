import { createGraph, type GraphDocument } from './model';
import { type GraphProfile } from './profile';
/** A non-business relation graph. No domain adapter is imported by this package. */
export const relationProfile: GraphProfile = {
  schemaVersion: 1,
  id: 'relations',
  version: 1,
  graph: {
    schema: { title: { type: 'string', required: true }, notes: { type: 'string' } },
    ui: {
      order: ['title', 'notes'],
      fields: { title: { label: 'Title' }, notes: { label: 'Notes' } },
    },
  },
  nodes: {
    entity: {
      schema: {
        name: { type: 'string', required: true },
        category: { type: 'enum', enum: ['Resource', 'Topic'] },
        active: { type: 'boolean' },
        score: { type: 'number', minimum: 0 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        details: { type: 'object', properties: { description: { type: 'string' } } },
      },
      ui: {
        label: 'Entity',
        labelField: 'name',
        order: ['name', 'category', 'active', 'score', 'tags', 'details'],
      },
    },
  },
  edges: {
    related: {
      schema: { label: { type: 'string' }, weight: { type: 'number', minimum: 0 } },
      ui: { label: 'Related', labelField: 'label' },
      connection: { allowSelf: true, allowParallel: true, allowCycles: true },
    },
  },
};
export function createRelationGraph(): GraphDocument {
  const graph = createGraph(relationProfile);
  graph.attributes = { title: 'Resource map', notes: 'A generic typed relation graph' };
  graph.nodes = [
    {
      id: 'resource-a',
      type: 'entity',
      attributes: {
        name: 'Research',
        category: 'Resource',
        active: true,
        score: 1,
        tags: ['sample'],
        details: { description: 'Public example' },
      },
    },
    {
      id: 'resource-b',
      type: 'entity',
      attributes: { name: 'Planning', category: 'Topic', active: false, score: 2 },
    },
  ];
  graph.edges = [
    {
      id: 'relation-a-b',
      type: 'related',
      from: 'resource-a',
      to: 'resource-b',
      attributes: { label: 'supports', weight: 1 },
    },
  ];
  graph.layout = { 'resource-a': { x: 40, y: 60 }, 'resource-b': { x: 360, y: 160 } };
  return graph;
}
