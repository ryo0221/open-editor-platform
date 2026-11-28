// The definition's side of the Mind Map link (design §7, U6 A). The link is kept on the Mind Map
// branch only (`link: {namespace: 'owd:<definition id>', id: '<kind>:<element id>'}`); this file
// reads it, checks it against the definition and builds the link requests a Host applies to the
// Mind Map as its own proposal. Nothing here changes a Mind Map.
import { findOwdElement, owdElementKey, parseOwdElementKey, type OwdElementRef } from './ids';
import { type OwdDefinition } from './types';

export interface OwdMindmapLink {
  namespace: string;
  id: string;
}
/** A branch the Host offers, read like an `ItemReferenceHost` item: its id, title and link. */
export interface OwdMindmapBranch {
  /** The Mind Map node id. */
  nodeId: string;
  title: string;
  link?: OwdMindmapLink;
}
/**
 * How a branch stands against the definition: `linked` to an element that exists, `missing` (the
 * linked element was renamed or deleted), `other` (linked to another definition or to something
 * else), or `unlinked`.
 */
export type OwdBranchStatus =
  | { status: 'linked'; target: OwdElementRef }
  | { status: 'missing'; target: OwdElementRef }
  | { status: 'other' }
  | { status: 'unlinked' };
/** A request to the Host: set (or with `link: null`, remove) one branch's link. */
export interface OwdMindmapLinkRequest {
  nodeId: string;
  link: OwdMindmapLink | null;
}

export const owdMindmapNamespace = (definition: OwdDefinition) => `owd:${definition.id}`;
export const owdMindmapLink = (definition: OwdDefinition, ref: OwdElementRef): OwdMindmapLink => ({
  namespace: owdMindmapNamespace(definition),
  id: owdElementKey(ref),
});
export function owdBranchStatus(
  definition: OwdDefinition,
  branch: OwdMindmapBranch,
): OwdBranchStatus {
  if (!branch.link) return { status: 'unlinked' };
  if (branch.link.namespace !== owdMindmapNamespace(definition)) return { status: 'other' };
  const target = parseOwdElementKey(branch.link.id);
  if (!target) return { status: 'other' };
  return findOwdElement(definition, target)
    ? { status: 'linked', target }
    : { status: 'missing', target };
}
/** Branches linked to `ref` in this definition. */
export const owdLinkedBranches = (
  definition: OwdDefinition,
  branches: readonly OwdMindmapBranch[],
  ref: OwdElementRef,
) =>
  branches.filter((b) => {
    const s = owdBranchStatus(definition, b);
    return (
      s.status !== 'other' &&
      s.status !== 'unlinked' &&
      s.target.kind === ref.kind &&
      s.target.id === ref.id
    );
  });
/** The link requests that follow an element ID change: branches that named the old ID get the new one. */
export function owdRenameLinkRequests(
  definition: OwdDefinition,
  branches: readonly OwdMindmapBranch[],
  ref: OwdElementRef,
  to: string,
): OwdMindmapLinkRequest[] {
  const namespace = owdMindmapNamespace(definition);
  return branches
    .filter((b) => b.link?.namespace === namespace && b.link.id === owdElementKey(ref))
    .map((b) => ({
      nodeId: b.nodeId,
      link: { namespace, id: owdElementKey({ kind: ref.kind, id: to }) },
    }));
}
