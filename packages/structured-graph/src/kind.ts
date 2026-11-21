import { defineKind } from '@editor-platform/artifact-kinds';
import {
  assertGraph,
  upgradeGraphDocument,
  type GraphDocument,
  type GraphProfile,
} from './headless';

/**
 * The Graph vocabulary belongs to the Host (its Profiles and templates), so the Host passes them:
 * `create` makes a template's graph and `profileFor` finds the Profile a stored graph names.
 */
export interface StructuredGraphKindHost {
  create(template?: string): GraphDocument;
  profileFor(graph: GraphDocument): GraphProfile | undefined;
}

/** The Structured Graph kind (docs/kind-registry-design.md). Options: `{ template }`. */
export const structuredGraphKind = (host: StructuredGraphKindHost) =>
  defineKind<GraphDocument>({
    kind: 'structured-graph',
    area: 'office',
    label: 'Structured Graph',
    icon: '⌘',
    description: 'Edit typed nodes, relations and attributes',
    creatable: true,
    create: (count, options) => ({
      name: `Structured Graph ${count}`,
      content: host.create((options as { template?: string } | undefined)?.template),
    }),
    validate(content): content is GraphDocument {
      try {
        // A stored draft or version of an older schema is valid if it reads as the current one.
        const graph = upgradeGraphDocument(content);
        if (!graph) return false;
        const profile = host.profileFor(graph);
        if (!profile) return false;
        assertGraph(graph, profile);
        return true;
      } catch {
        return false;
      }
    },
  });
