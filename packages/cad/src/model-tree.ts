/**
 * The body and feature tree of the Navigator (docs/cad/complex-models.md, U5): each active body
 * with the features its result reads, in evaluation order, and under a Boolean the tool bodies it
 * consumed with their own features. Display only: nothing here is stored.
 */
import {
  dependencyEdges,
  dependencyOrder,
  type CadBody,
  type CadDocument,
  type CadFeature,
} from '@editor-platform/cad-core';

export interface CadTreeBody {
  kind: 'body';
  body: CadBody;
  children: CadTreeNode[];
}
export interface CadTreeFeature {
  kind: 'feature';
  feature: CadFeature;
  /** Tool bodies this feature consumed, each with its own features. */
  tools: CadTreeBody[];
}
export type CadTreeNode = CadTreeBody | CadTreeFeature;

export function modelTree(doc: CadDocument): CadTreeBody[] {
  const features = new Map(doc.features.map((f) => [f.id, f]));
  // Evaluation order: a feature read through args or a sketch may come later in the array.
  const sorted = dependencyOrder(doc);
  const order = new Map(
    ('order' in sorted ? sorted.order : doc.features.map((f) => f.id)).map((id, i) => [id, i]),
  );
  // Inputs, sketches and the references in args; a sketch is walked through to the face it is
  // attached to, but is not a node of this tree.
  const reads = dependencyEdges(doc);
  // A consumed body's result: the feature that consumed it shows it as a tool; any other reader
  // walks it like any feature.
  const toolAt = new Map<string, CadBody>();
  for (const b of doc.bodies) if (b.state === 'consumed') toolAt.set(b.resultFeatureId, b);
  const bodyNode = (body: CadBody, seen: Set<string>): CadTreeBody => {
    const own: CadFeature[] = [];
    const tools = new Map<string, CadBody[]>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const f = features.get(id);
      if (f) own.push(f);
      for (const input of reads.get(id) ?? []) {
        const used = toolAt.get(input);
        if (f && used && used.state === 'consumed' && used.consumedByFeatureId === f.id)
          tools.set(f.id, [...(tools.get(f.id) ?? []), used]);
        else walk(input);
      }
    };
    walk(body.resultFeatureId);
    own.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return {
      kind: 'body',
      body,
      children: own.map((feature) => ({
        kind: 'feature',
        feature,
        tools: (tools.get(feature.id) ?? []).map((t) => bodyNode(t, seen)),
      })),
    };
  };
  // Each body's tree is its whole closure: a feature two bodies read appears under both, once
  // in each tree.
  return doc.bodies.filter((b) => b.state === 'active').map((b) => bodyNode(b, new Set()));
}
