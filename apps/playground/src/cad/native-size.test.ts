import { describe, expect, it, vi } from 'vitest';
import {
  commitVersion,
  createArtifact,
  deepFreeze,
  serializeArtifact,
} from '@editor-platform/artifact-core';
import { cadContentHash, f02Plate, r2bParts, type CadDocument } from '@editor-platform/cad-core';
import { EditorSession } from '@editor-platform/editor-core';
import type { StoredArtifact } from '../model';
import {
  assertCadContentFits,
  cadCountCacheEntries,
  cadNativeCodecVersion,
  CadNativeCounter,
  utf8Length,
} from './native-size';
import { cadNativeFileBytes, portableCadRecord, type CadResource } from './resources';

/** The real serializer, the reference the counter must match exactly. */
const real = (r: StoredArtifact) =>
  new TextEncoder().encode(serializeArtifact(portableCadRecord(r))).length;
const asset = (kind: CadResource['kind'], n: number, sha = n.toString(16)) => ({
  ref: {
    id: `a-${kind}-${sha}`,
    kind,
    sha256: `sha256:${sha.padStart(64, '0')}`,
    byteLength: n,
    mediaType: kind === 'source-step' ? 'model/step' : 'model/x-occt-brep',
  },
  // Base64 of n bytes: 4·ceil(n/3) characters, padded with one or two '=' when n is not a multiple.
  resource: {
    kind,
    sha256: `sha256:${sha.padStart(64, '0')}`,
    byteLength: n,
    mediaType: kind === 'source-step' ? 'model/step' : 'model/x-occt-brep',
    encoding: 'base64' as const,
    bytes: 'QUJD'.repeat(Math.floor(n / 3)) + ['', 'QQ==', 'QUI='][n % 3],
  },
});
/** F02 with text and numbers that exercise the JSON escaping and number forms. */
function plate(name: string, numbers: number[] = []): CadDocument {
  const doc = structuredClone(f02Plate());
  doc.bodies[0].name = name;
  numbers.forEach((value, i) =>
    doc.parameters.push({ id: `n${i}`, name: `n${i}`, type: 'length', value }),
  );
  return doc;
}
async function record(
  draft: CadDocument,
  versions: CadDocument[] = [],
  resources: CadResource[] = [],
  name = 'Part',
): Promise<StoredArtifact> {
  let artifact = createArtifact('cad', name, versions[0] ?? draft);
  for (const [i, content] of versions.entries())
    artifact = await commitVersion(
      { ...artifact, draft: { ...artifact.draft, content } },
      'local-user',
      `v${i} “版” \\ "q"`,
    );
  return {
    ...artifact,
    draft: { ...artifact.draft, content: draft },
    annotations: [],
    ...(resources.length ? { cadResources: resources } : {}),
  } as StoredArtifact;
}
const strange = 'a "quote" \\ back\nline\ttab \u0000 \u001f \u007f     é 日本 😀 \ud800 x';

describe('CAD native byte counter (CAD23)', () => {
  it('counts UTF-8 like the encoder, lone surrogates included', () => {
    for (const text of ['', 'abc', 'é', '日本', '😀', '\ud800', '\udc00x', 'a\ud83d', strange])
      expect(utf8Length(text), JSON.stringify(text)).toBe(new TextEncoder().encode(text).length);
  });

  it('is not misled by names that spell its placeholders', async () => {
    // The fixed spelling of an earlier counter, and one with this counter's own nonce: either
    // the placeholder is unique, or the record is serialized in full.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      for (const name of [
        '\u0000cad-native-0',
        '\u0000cad-native-1-i-0',
        '\u0000cad-asset-2-i-0',
      ]) {
        const counter = new CadNativeCounter();
        const r = await record(plate(name), [plate('v')], [], name);
        expect(counter.count(r), name).toBe(real(r));
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('matches the real serializer for text, escapes, numbers, padding, duplicates and every version', async () => {
    const counter = new CadNativeCounter();
    const step = [1, 2, 3, 4].map((n) => asset('source-step', n));
    const brep = asset('normalized-brep', 5);
    const withAssets = (doc: CadDocument, ...assets: (typeof brep)[]) => ({
      ...doc,
      assets: assets.map((a) => a.ref),
    });
    const cases: [string, StoredArtifact][] = [
      ['plain', await record(f02Plate())],
      [
        'escapes in names and metadata',
        await record(plate(strange), [plate('v')], [], `名前 ${strange}`),
      ],
      [
        'number forms',
        await record(
          plate('n', [-0, 0.1 + 0.2, 1e21, 1e-7, 123456789.125, Number.MAX_SAFE_INTEGER]),
        ),
      ],
      [
        'base64 padding 0, 1 and 2 and a shared asset',
        await record(
          withAssets(f02Plate(), step[0], step[1], brep),
          [withAssets(plate('v1'), step[2], brep), withAssets(plate('v2'), step[3], brep)],
          [step[0], step[1], step[2], step[3], brep].map((a) => a.resource),
        ),
      ],
      [
        'unreferenced bytes stay out of the file',
        await record(f02Plate(), [], [asset('source-step', 7).resource]),
      ],
      [
        'many versions',
        await record(
          plate('d'),
          Array.from({ length: 12 }, (_, i) => plate(`v${i}`)),
        ),
      ],
    ];
    for (const [label, r] of cases) expect(counter.count(r), label).toBe(real(r));
  });

  it('counts the retained part closure (R2b-1, CAD53), once per hash and without unplaced versions', async () => {
    const f = r2bParts();
    const r = await record(deepFreeze(f.assembly), [f.assembly]);
    r.cadParts = [...f.closure].map(([contentHash, content]) => ({ contentHash, content }));
    const counter = new CadNativeCounter();
    expect(counter.count(r)).toBe(real(r));
    // A staged version nothing places yet is not in the file, nor in the count.
    const extra = structuredClone(f.plate.content);
    extra.partProperties.description = strange;
    r.cadParts.push({ contentHash: cadContentHash(extra), content: extra });
    const encoded = counter.encoded;
    expect(counter.count(r)).toBe(real(r));
    expect(counter.encoded).toBe(encoded);
  });

  it('counts a candidate as the edited draft, its asset closure included', async () => {
    const counter = new CadNativeCounter();
    const step = asset('source-step', 4000);
    const base = await record(f02Plate(), [], [step.resource]);
    // The draft does not name the asset yet: the record's file leaves it out.
    expect(counter.count(base)).toBe(real(base));
    const candidate = { ...plate('with asset'), assets: [step.ref] };
    const receipt = await counter.prepare(candidate, cadContentHash(candidate));
    const edited: StoredArtifact = { ...base, draft: { ...base.draft, content: candidate } };
    expect(counter.count(base, { content: candidate, fragment: receipt.fragment })).toBe(
      real(edited),
    );
  });

  it('admits at the limit and refuses one byte over it, before and after the boundary', async () => {
    const counter = new CadNativeCounter();
    const doc = f02Plate();
    const filler = asset('source-step', 11_000_000);
    const base = await record({ ...doc, assets: [filler.ref] }, [], [filler.resource], '');
    const free = cadNativeFileBytes - real(base);
    expect(free).toBeGreaterThan(0);
    const receipt = await counter.prepare(base.draft.content as CadDocument, 'h');
    for (const [delta, fits] of [
      [-1, true],
      [0, true],
      [1, false],
    ] as const) {
      // The artifact name is written once, one byte per ASCII character.
      const r = { ...base, name: 'x'.repeat(free + delta) };
      expect(real(r)).toBe(cadNativeFileBytes + delta);
      expect(counter.count(r)).toBe(real(r));
      expect(counter.admit(receipt, r.draft.content as CadDocument, r), String(delta)).toBe(
        fits ? undefined : cadNativeFileBytes + delta,
      );
    }
  });

  it('re-encodes no content for a check: receipts and frozen contents are counted once', async () => {
    const counter = new CadNativeCounter();
    const versions = [plate('v1'), plate('v2')].map((d) => deepFreeze(d));
    const r = await record(deepFreeze(plate('draft')), versions);
    counter.count(r);
    const encoded = counter.encoded;
    expect(encoded).toBe(3);
    const candidate = plate('candidate');
    const receipt = await counter.prepare(candidate, cadContentHash(candidate));
    expect(counter.encoded).toBe(encoded + 1);
    for (let i = 0; i < 5; i++) counter.admit(receipt, candidate, r);
    counter.count(r);
    expect(counter.encoded).toBe(encoded + 1);
    // The same content again, as a new object: found by its hash.
    const again = plate('candidate');
    await counter.prepare(again, cadContentHash(again));
    expect(counter.encoded).toBe(encoded + 1);
  });

  it('expires a receipt of another codec, and keeps at most 1,024 counts by hash', async () => {
    const counter = new CadNativeCounter();
    const r = await record(f02Plate());
    const candidate = plate('c');
    const receipt = await counter.prepare(candidate, cadContentHash(candidate));
    // A receipt whose counts are wrong for this codec is never trusted: the content is counted again.
    const wrong = {
      ...receipt,
      codecVersion: cadNativeCodecVersion + 1,
      fragment: { bytes: 0, newlines: 0 },
    };
    const edited = { ...r, draft: { ...r.draft, content: candidate } };
    expect(counter.admit(wrong, candidate, r)).toBeUndefined();
    expect(counter.count(r, { content: candidate, fragment: receipt.fragment })).toBe(real(edited));
    for (let i = 0; i <= cadCountCacheEntries; i++) await counter.prepare(f02Plate(), `h${i}`);
    const before = counter.encoded;
    await counter.prepare(f02Plate(), 'h0');
    expect(counter.encoded).toBe(before + 1);
    await counter.prepare(f02Plate(), `h${cadCountCacheEntries}`);
    expect(counter.encoded).toBe(before + 1);
  });

  it('checks the latest record: a version saved after the count can refuse the candidate', async () => {
    const counter = new CadNativeCounter();
    const filler = asset('source-step', 11_000_000);
    const big = { ...plate('x'.repeat(200)), assets: [filler.ref] };
    const base = await record(big, [], [filler.resource]);
    const candidate = { ...big, bodies: big.bodies.map((b) => ({ ...b, name: 'y'.repeat(200) })) };
    const receipt = await counter.prepare(candidate, cadContentHash(candidate));
    expect(counter.admit(receipt, candidate, base)).toBeUndefined();
    // A version save started meanwhile: the record it writes holds one more content.
    const saved = await record(candidate, [big], [filler.resource]);
    const padded = {
      ...saved,
      name: saved.name + 'x'.repeat(cadNativeFileBytes - real(saved) + 1),
    };
    expect(counter.admit(receipt, candidate, padded)).toBe(real({ ...padded }));
  });

  it('does not encode content again when Undo and Redo move between counted contents', async () => {
    const counter = new CadNativeCounter();
    const session = new EditorSession<CadDocument>(f02Plate());
    session.execute({ type: 'set', label: 'set', apply: () => plate('a') });
    session.execute({ type: 'set', label: 'set', apply: () => plate('b') });
    const r = await record(session.content);
    // As the Playground steps through history: the entry is admitted, then the step is taken.
    const step = (direction: 'undo' | 'redo') => {
      const candidate = session.peekHistory(direction)!;
      expect(counter.admitContent(r, candidate)).toBeUndefined();
      session[direction]();
    };
    step('undo');
    step('undo');
    step('redo');
    step('redo');
    const encoded = counter.encoded;
    for (let i = 0; i < 3; i++) {
      step('undo');
      step('undo');
      step('redo');
      step('redo');
    }
    expect(counter.encoded).toBe(encoded);
  });

  it('refuses Undo to content that no longer fits and keeps the session as it was', async () => {
    const small = deepFreeze(f02Plate());
    const session = new EditorSession<CadDocument>(small);
    const filler = asset('source-step', 11_000_000);
    const larger = { ...plate('z'.repeat(100)), assets: [filler.ref] };
    session.execute({ type: 'set', label: 'set', apply: () => larger });
    const r = await record(session.content, [session.content], [filler.resource]);
    // The earlier, smaller content fits; padding the envelope makes the larger draft just fit.
    const tight = { ...r, name: r.name + 'x'.repeat(cadNativeFileBytes - real(r)) };
    expect(real(tight)).toBe(cadNativeFileBytes);
    expect(() => assertCadContentFits(tight, larger, 'Undoする')).not.toThrow();
    const huge = { ...plate('w'.repeat(250)), assets: [filler.ref] };
    expect(() => assertCadContentFits(tight, huge, 'Undoする')).toThrow(
      /^Undoすると、native fileが16\.0 MBになり、上限の16 MBを超えます。内容は変えていません。$/,
    );
    const revision = session.revision;
    expect(() =>
      session.undo((candidate) =>
        assertCadContentFits(tight, { ...candidate, ...huge }, 'Undoする'),
      ),
    ).toThrow(/Undoすると/);
    expect(session.content).toEqual(larger);
    expect(session.revision).toEqual(revision);
    expect(session.canUndo).toBe(true);
  });
});
