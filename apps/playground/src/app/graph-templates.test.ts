import { describe, expect, it } from 'vitest';
import { isGraphDocument, validateGraph } from '@editor-platform/structured-graph/model';
import { graphProfileFor, graphTemplates } from './graph-templates';

describe('graph templates', () => {
  it.each(graphTemplates.map((t) => [t.id, t] as const))(
    '%s opens as a valid Graph of its registered Profile',
    (_, template) => {
      const graph = template.create();
      expect(isGraphDocument(graph)).toBe(true);
      expect(graph.profile).toMatchObject({
        id: template.profile.id,
        version: template.profile.version,
      });
      expect(graphProfileFor(graph)).toBe(template.profile);
      expect(validateGraph(graph, template.profile)).toEqual([]);
    },
  );

  it('places every architecture node inside its Section frame', () => {
    const graph = graphTemplates.find((t) => t.id === 'architecture')!.create();
    for (const node of graph.nodes.filter((n) => n.sectionId)) {
      const at = graph.presentation.nodes[node.id],
        frame = graph.presentation.sections[node.sectionId!];
      expect(at.x).toBeGreaterThanOrEqual(frame.x);
      expect(at.y).toBeGreaterThanOrEqual(frame.y);
      expect(at.x + 200).toBeLessThanOrEqual(frame.x + frame.width);
      expect(at.y + 70).toBeLessThanOrEqual(frame.y + frame.height);
    }
  });
});
