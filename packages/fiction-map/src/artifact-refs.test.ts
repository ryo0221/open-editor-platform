// GV2a (docs/cad/gulliver-world.md): a map feature pins fixed CAD/BIM versions by ID and hash.
import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import { parseFictionMap, serializeFictionMap, validateFictionMap } from './admission';
import { pinLabel } from './artifact-refs';
import { commitFictionMapChange, prepareFictionMapChange } from './commands';
import { updateFeatureMetadata } from './constructors';
import { fictionMapLimits } from './limits';
import { unwrap } from './result';
import { draft, layer, native, pointFeature } from './test-data';
import type { FictionMapArtifactRef, FictionMapContent } from './types';

const hash = (c: string) => c.repeat(64);
const ref = (id = 'temple', extra: Partial<FictionMapArtifactRef> = {}): FictionMapArtifactRef => ({
  artifactId: id,
  domain: 'bim',
  versionId: 'v-' + id,
  contentHash: hash('a'),
  ...extra,
});
const withRefs = (artifactRefs: unknown) => ({
  ...draft(),
  layers: [layer()],
  features: [{ ...pointFeature(), artifactRefs }],
});
function rejects(input: unknown, code: string, path: string) {
  expect(validateFictionMap(input)).toMatchObject({ ok: false, diagnostic: { code, path } });
}

describe('feature artifactRefs (ST-641, TS-2301)', () => {
  it('admits pinned versions, keeps schemaVersion 1 and round-trips them', () => {
    const c = unwrap(
      validateFictionMap(withRefs([ref('temple', { label: 'Old temple' }), ref('engine')])),
    );
    expect(c.schemaVersion).toBe(1);
    expect(c.features[0].artifactRefs).toEqual([
      ref('temple', { label: 'Old temple' }),
      ref('engine'),
    ]);
    expect(unwrap(parseFictionMap(unwrap(serializeFictionMap(c))))).toEqual(c);
    // Maps without the field are unchanged.
    expect(native().features[0]).not.toHaveProperty('artifactRefs');
  });
  it('rejects malformed pins', () => {
    rejects(withRefs([]), 'invalid-field', '/features/0/artifactRefs');
    rejects(withRefs({}), 'invalid-field', '/features/0/artifactRefs');
    rejects(
      withRefs(
        Array.from({ length: fictionMapLimits.artifactRefsPerFeature + 1 }, (_, i) => ref('a' + i)),
      ),
      'invalid-field',
      '/features/0/artifactRefs',
    );
    rejects(withRefs([ref(), ref()]), 'duplicate-id', '/features/0/artifactRefs/1/artifactId');
    rejects(
      withRefs([ref('t', { contentHash: hash('A') })]),
      'invalid-field',
      '/features/0/artifactRefs/0/contentHash',
    );
    rejects(
      withRefs([ref('t', { contentHash: 'abc' })]),
      'invalid-field',
      '/features/0/artifactRefs/0/contentHash',
    );
    rejects(
      withRefs([ref('t', { domain: 'CAD' })]),
      'invalid-field',
      '/features/0/artifactRefs/0/domain',
    );
    rejects(
      withRefs([ref('t', { versionId: '' })]),
      'invalid-string',
      '/features/0/artifactRefs/0/versionId',
    );
    rejects(
      withRefs([{ ...ref(), content: {} }]),
      'unknown-field',
      '/features/0/artifactRefs/0/content',
    );
    const { versionId: _omit, ...noVersion } = ref();
    rejects(withRefs([noVersion]), 'invalid-field', '/features/0/artifactRefs/0/versionId');
  });
  it('pins and unpins through one undoable metadata command', () => {
    const content = native(),
      session = new EditorSession<FictionMapContent>(content);
    let base = { content, revision: session.revision };
    const commit = (patch: Parameters<typeof updateFeatureMetadata>[2]) => {
      const change = unwrap(updateFeatureMetadata(base.content, 'p', patch));
      const next = unwrap(
        commitFictionMapChange(session, unwrap(prepareFictionMapChange(base, change)), () => true),
      );
      base = { content: next.content, revision: next.revision };
    };
    commit({ set: { artifactRefs: [ref()] } });
    expect(base.content.features[0].artifactRefs).toEqual([ref()]);
    commit({ clear: ['artifactRefs'] });
    expect(base.content.features[0]).not.toHaveProperty('artifactRefs');
    session.undo();
    expect(session.content.features[0].artifactRefs).toEqual([ref()]);
    const bad = unwrap(
      updateFeatureMetadata(base.content, 'p', {
        set: { artifactRefs: [ref('x', { contentHash: 'nope' })] },
      }),
    );
    expect(prepareFictionMapChange(base, bad)).toMatchObject({
      ok: false,
      diagnostic: { code: 'invalid-field', path: '/features/0/artifactRefs/0/contentHash' },
    });
  });
  it('turns any Host name into an admissible optional label', () => {
    const long = '神'.repeat(200),
      emoji = '🏛'.repeat(100);
    expect(pinLabel('  Old temple  ')).toBe('Old temple');
    expect(pinLabel('')).toBeUndefined();
    expect(pinLabel(' \t\n ')).toBeUndefined();
    expect(pinLabel('a\u0000b')).toBe('a b');
    expect(pinLabel(long)).toBe('神'.repeat(128));
    // 64 pairs fill 128 units; a pair is never split.
    expect(pinLabel(emoji)).toBe('🏛'.repeat(64));
    expect(pinLabel('x' + emoji)).toBe('x' + '🏛'.repeat(63));
    expect(pinLabel('a\ud800b')).toBe('ab');
    for (const name of ['  Old temple  ', long, emoji, 'x' + emoji, 'a\u0000b', 'a\ud800b']) {
      const label = pinLabel(name)!;
      expect(validateFictionMap(withRefs([ref('t', { label })])).ok).toBe(true);
    }
  });
});
