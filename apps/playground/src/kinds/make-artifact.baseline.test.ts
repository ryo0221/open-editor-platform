import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitVersion,
  contentHash,
  createArtifact,
  deserializeArtifact,
  serializeArtifact,
} from '@editor-platform/artifact-core';
import { bimStarter } from '@editor-platform/bim-core';
import { f02Plate } from '@editor-platform/cad-core';
import { kinds, makeArtifact, validContent, type Kind, type StoredArtifact } from '../model';
import { simulationSourceChoices } from '../simulation/source';
import { constructionSourceChoices } from '../construction/source';

// A fixed kernel build, so the CAD baseline does not depend on CAD_OCCT_DIST.
vi.mock('virtual:cad-kernel-build', () => ({
  default: { id: 'kr4-baseline-kernel', buildHash: `sha256:${'1'.repeat(64)}` },
  kernels: [],
}));

// KR4 acceptance (docs/kind-registry-design.md): what a new Artifact of every kind is today, and
// that it saves and reloads unchanged. The kind registry must reproduce these records exactly.

const stored = async (kind: string, name: string, content: unknown) =>
  ({
    ...(await commitVersion(createArtifact(kind, name, content), null, 'v1')),
    annotations: [],
  }) as unknown as StoredArtifact;

/** Ids and times are the only nondeterministic parts; give them fixed values. */
function deterministic() {
  let n = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () =>
      `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
  );
  vi.useFakeTimers({ now: new Date('2026-11-21T00:00:00Z'), toFake: ['Date'] });
  // A new schedule takes the machine's time zone; fix it so the baseline holds anywhere.
  const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...resolved.call(this), timeZone: 'UTC' };
  });
}

async function sources() {
  const cad = await stored('cad', 'Plate', f02Plate());
  const bim = await stored('bim', 'House', bimStarter());
  return {
    simulation: simulationSourceChoices([cad])[0],
    construction: constructionSourceChoices([bim])[0],
  };
}

async function create(kind: Kind) {
  deterministic();
  const choice = await sources();
  return kind === 'simulation'
    ? makeArtifact(kind, 1, undefined, choice.simulation)
    : kind === 'construction'
      ? makeArtifact(kind, 1, undefined, choice.construction)
      : makeArtifact(kind, 1);
}

describe('a new Artifact of every kind (KR4 baseline)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const all = Object.keys(kinds) as Kind[];
  it('covers all 27 kinds', () => expect(all).toHaveLength(27));
  for (const kind of all)
    it(`${kind}: name, content and extras, then save and reload`, async () => {
      const record = await create(kind);
      expect(record.kind).toBe(kind);
      expect(validContent(kind, record.draft.content)).toBe(true);
      const { draft, versions, annotations, id, kind: k, name, ...rest } = record;
      expect({
        id,
        kind: k,
        name,
        content: draft.content,
        versions: versions.length,
        annotations,
        extras: Object.keys(rest).sort(),
        // The data beside the content (a character's mesh bytes, an analysis's retained CAD).
        extrasHash: await contentHash(rest),
      }).toMatchSnapshot();
      // Save (native JSON, as the Host writes it) and reload: the same record comes back.
      const reloaded = deserializeArtifact(serializeArtifact(record));
      // JSON keeps no negative zero (a character's rest pose has -0), so compare as JSON.
      expect(reloaded.draft).toEqual(JSON.parse(JSON.stringify(record.draft)));
      expect(serializeArtifact(reloaded)).toBe(serializeArtifact(record));
      expect(validContent(kind, reloaded.draft.content)).toBe(true);
      expect(structuredClone(record)).toEqual(record);
    });
});
