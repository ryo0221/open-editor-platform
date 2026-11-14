// GV2a: pinned versions resolve against saved records and open the Artifact they point at.
import { describe, expect, it, vi } from 'vitest';
import type { StoredArtifact } from '../model';
import { playgroundArtifactRefHost } from './artifact-refs';

const hash = (c: string) => c.repeat(64);
function record(id: string, kind: string, versions: number, base = versions): StoredArtifact {
  const list = Array.from({ length: versions }, (_, i) => ({
    versionId: `${id}-v${i + 1}`,
    contentHash: hash(String(i + 1)),
  }));
  return {
    id,
    name: id.toUpperCase(),
    kind,
    versions: list,
    draft: { baseVersionId: base ? `${id}-v${base}` : null },
  } as unknown as StoredArtifact;
}

describe('playground artifact refs (ST-641, TS-2301)', () => {
  const saved = new Map(
    [
      record('map', 'fiction-map', 1),
      record('temple', 'bim', 2, 1),
      record('engine', 'cad', 1),
      record('draft-only', 'cad', 0),
      record('note', 'document', 1),
    ].map((r) => [r.id, r]),
  );
  const activate = vi.fn(),
    setStatus = vi.fn();
  const host = playgroundArtifactRefHost({
    mapId: 'map',
    saved: () => saved,
    activate,
    setStatus,
  });
  it('offers the latest saved CAD/BIM version of other Artifacts only', () => {
    expect(host.options().map((o) => o.ref)).toEqual([
      {
        artifactId: 'engine',
        domain: 'cad',
        versionId: 'engine-v1',
        contentHash: hash('1'),
        label: 'ENGINE',
      },
      {
        artifactId: 'temple',
        domain: 'bim',
        versionId: 'temple-v2',
        contentHash: hash('2'),
        label: 'TEMPLE',
      },
    ]);
  });
  it('reports each way a pin can stop resolving', () => {
    const pin = {
      artifactId: 'temple',
      domain: 'bim',
      versionId: 'temple-v1',
      contentHash: hash('1'),
    };
    expect(host.status(pin)).toBe('ready');
    expect(host.status({ ...pin, artifactId: 'gone' })).toBe('missing-source');
    expect(host.status({ ...pin, versionId: 'temple-v9' })).toBe('missing-version');
    expect(host.status({ ...pin, contentHash: hash('f') })).toBe('hash-mismatch');
    expect(host.status({ ...pin, domain: 'cad' })).toBe('wrong-domain');
    expect(host.status({ ...pin, artifactId: 'note', domain: 'document' })).toBe('wrong-domain');
  });
  it('opens the Artifact and says which version the map pins', () => {
    const old = {
      artifactId: 'temple',
      domain: 'bim',
      versionId: 'temple-v1',
      contentHash: hash('1'),
    };
    host.open(old);
    expect(activate).toHaveBeenLastCalledWith('temple');
    expect(setStatus).toHaveBeenLastCalledWith('Opened TEMPLE: the map pins version 1 of 2.');
    const engine = {
      artifactId: 'engine',
      domain: 'cad',
      versionId: 'engine-v1',
      contentHash: hash('1'),
    };
    host.open(engine);
    expect(setStatus).toHaveBeenLastCalledWith('Opened ENGINE: the map pins version 1 of 1.');
    host.open({ ...old, versionId: 'temple-v2', contentHash: hash('2') });
    expect(setStatus).toHaveBeenLastCalledWith(
      'Opened TEMPLE: the map pins version 2 of 2. The draft starts from another version; History shows the pinned one.',
    );
    activate.mockClear();
    host.open({ ...old, contentHash: hash('9') });
    expect(activate).not.toHaveBeenCalled();
  });
  it('offers Artifacts whose names are blank or long, with a bounded label or none', () => {
    const odd = new Map(
      [
        { ...record('blank', 'cad', 1), name: '   ' },
        { ...record('long', 'bim', 1), name: 'L'.repeat(300) },
      ].map((r) => [r.id, r as StoredArtifact]),
    );
    const refs = playgroundArtifactRefHost({
      mapId: 'map',
      saved: () => odd,
      activate,
      setStatus,
    }).options();
    expect(refs.map((o) => o.label)).toEqual([
      'blank · CAD · version 1',
      `${'L'.repeat(128)} · BIM · version 1`,
    ]);
    expect(refs[0].ref).not.toHaveProperty('label');
    expect(refs[1].ref.label).toHaveLength(128);
  });
});
