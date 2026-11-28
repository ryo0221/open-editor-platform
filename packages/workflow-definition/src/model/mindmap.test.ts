import { describe, expect, it } from 'vitest';
import { sampleDefinition } from './fixtures';
import {
  applyWorkflowDefinitionIntents as apply,
  owdBranchStatus,
  owdLinkedBranches,
  owdMindmapLink,
  owdRenameLinkRequests,
  type OwdMindmapBranch,
} from './index';

const d = sampleDefinition();
const ns = `owd:${d.id}`;
const branches: OwdMindmapBranch[] = [
  { nodeId: 'a', title: '調べる', link: { namespace: ns, id: 'phase:research' } },
  { nodeId: 'b', title: 'gone', link: { namespace: ns, id: 'phase:gone' } },
  { nodeId: 'c', title: 'other', link: { namespace: 'owd:another', id: 'phase:research' } },
  { nodeId: 'd', title: 'free' },
  { nodeId: 'e', title: 'not an element', link: { namespace: ns, id: 'research' } },
];

describe('Mind Map links (#99 WD4)', () => {
  it('names an element with its kind in the definition namespace', () => {
    expect(owdMindmapLink(d, { kind: 'item', id: 'fact' })).toEqual({
      namespace: ns,
      id: 'item:fact',
    });
  });
  it('tells linked, missing, other and unlinked branches apart', () => {
    expect(branches.map((b) => owdBranchStatus(d, b).status)).toEqual([
      'linked',
      'missing',
      'other',
      'unlinked',
      'other',
    ]);
    expect(
      owdLinkedBranches(d, branches, { kind: 'phase', id: 'research' }).map((b) => b.nodeId),
    ).toEqual(['a']);
    // A phase and an item may share an ID; the kind keeps their links apart.
    expect(owdLinkedBranches(d, branches, { kind: 'item', id: 'research' })).toEqual([]);
  });
  it('asks the Host to follow an ID change, and shows deletions as missing', () => {
    expect(owdRenameLinkRequests(d, branches, { kind: 'phase', id: 'research' }, 'survey')).toEqual(
      [{ nodeId: 'a', link: { namespace: ns, id: 'phase:survey' } }],
    );
    const renamed = apply(d, [{ type: 'rename-id', kind: 'phase', id: 'research', to: 'survey' }]);
    expect(owdBranchStatus(renamed, branches[0]).status).toBe('missing');
    const removed = apply(d, [{ type: 'delete', kind: 'phase', id: 'research' }]);
    expect(owdBranchStatus(removed, branches[0])).toEqual({
      status: 'missing',
      target: { kind: 'phase', id: 'research' },
    });
  });
});
