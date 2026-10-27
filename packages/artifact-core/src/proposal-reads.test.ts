import { describe, expect, it } from 'vitest';
import {
  checkProposalReads,
  checkReadVersions,
  validProposalReads,
  type CurrentRead,
  type ProposalReads,
} from './index';

const reads: ProposalReads = {
  target: { artifactId: 'plan-doc', versionId: 'doc-v1' },
  references: [
    { artifactId: 'calendar', versionId: 'cal-v1' },
    { artifactId: 'data', versionId: 'data-v1' },
  ],
};
const answers = (entries: Record<string, CurrentRead>) => (id: string) =>
  Object.hasOwn(entries, id) ? entries[id] : undefined;
const current = {
  'plan-doc': { status: 'available', versionId: 'doc-v1' },
  calendar: { status: 'available', versionId: 'cal-v1' },
  data: { status: 'available', versionId: 'data-v1' },
} satisfies Record<string, CurrentRead>;

describe('proposal read set', () => {
  it('accepts exact versions for the target and unique references', () => {
    expect(validProposalReads(reads)).toBe(true);
    expect(validProposalReads({ ...reads, target: { artifactId: 'new', versionId: null } })).toBe(
      true,
    );
    for (const bad of [
      null,
      { ...reads, references: [{ artifactId: 'calendar', versionId: null }] },
      { ...reads, references: [{ artifactId: 'plan-doc', versionId: 'doc-v1' }] },
      { ...reads, references: [reads.references[0], reads.references[0]] },
      { ...reads, references: [{ artifactId: '', versionId: 'v' }] },
      { ...reads, target: { artifactId: 'plan-doc', versionId: '' } },
      {
        ...reads,
        references: Array.from({ length: 65 }, (_, i) => ({ artifactId: `a${i}`, versionId: 'v' })),
      },
    ])
      expect(validProposalReads(bad)).toBe(false);
    expect(() =>
      checkProposalReads({ ...reads, references: 'x' } as never, () => undefined),
    ).toThrow('Invalid proposal read set');
  });
  it('is fresh only when every recorded version is still current', () => {
    expect(checkProposalReads(reads, answers(current))).toEqual({ fresh: true, stale: [] });
  });
  it('tells a changed Calendar, a changed Data, a deleted and a forbidden reference apart', () => {
    const cases: [Record<string, CurrentRead>, object][] = [
      [
        { ...current, calendar: { status: 'available', versionId: 'cal-v2' } },
        { artifactId: 'calendar', reason: 'version-changed', currentVersionId: 'cal-v2' },
      ],
      [
        { ...current, data: { status: 'changed' } },
        { artifactId: 'data', reason: 'version-changed' },
      ],
      [
        { ...current, data: { status: 'missing' } },
        { artifactId: 'data', reason: 'missing' },
      ],
      [
        { ...current, calendar: { status: 'forbidden' } },
        { artifactId: 'calendar', reason: 'forbidden' },
      ],
    ];
    for (const [state, expected] of cases) {
      const check = checkProposalReads(reads, answers(state));
      expect(check.fresh).toBe(false);
      expect(check.stale).toEqual([expect.objectContaining({ role: 'reference', ...expected })]);
    }
    // The Host withheld the version: no currentVersionId is invented.
    expect(
      checkProposalReads(reads, answers({ ...current, data: { status: 'changed' } })).stale[0],
    ).not.toHaveProperty('currentVersionId');
  });
  it('treats an unanswered reference as unverified and reports the target first', () => {
    const check = checkProposalReads(
      reads,
      answers({ 'plan-doc': { status: 'available', versionId: 'doc-v2' }, data: current.data }),
    );
    expect(check.stale.map((s) => [s.role, s.artifactId, s.reason])).toEqual([
      ['target', 'plan-doc', 'version-changed'],
      ['reference', 'calendar', 'unverified'],
    ]);
  });
  it('checks references held in another envelope with the same rules', () => {
    expect(
      checkReadVersions([{ artifactId: 'calendar', versionId: 'cal-v1' }], () => ({
        status: 'available',
        versionId: null,
      })),
    ).toEqual([
      {
        artifactId: 'calendar',
        role: 'reference',
        expectedVersionId: 'cal-v1',
        reason: 'version-changed',
        currentVersionId: null,
      },
    ]);
  });
});
