import 'fake-indexeddb/auto';
import { IndexedDBStorage } from '@editor-platform/artifact-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredArtifact } from '../model';
import { resourceChunks, resourcePartChars, resourceParts } from './records';

const resource = (sha256: string, chars: number) => ({
  kind: 'step' as const,
  sha256,
  byteLength: (chars / 4) * 3,
  mediaType: 'model/step',
  encoding: 'base64' as const,
  bytes: 'A'.repeat(chars),
});
const record = (cadResources: ReturnType<typeof resource>[]) =>
  ({ id: 'cad-1', kind: 'cad', cadResources }) as unknown as StoredArtifact;

describe('the Playground stores large CAD assets apart from their record (#812, ST-218)', () => {
  // TS-1449
  it('keeps small assets in the record and moves large ones out, by kind and hash', () => {
    const small = resource('s', 8);
    const large = resource('l', resourcePartChars);
    const { stub, parts } = resourceParts.split(record([small, large]));
    expect(stub.cadResources!.map((r) => r.bytes)).toEqual([small.bytes, '']);
    expect([...parts.keys()]).toEqual(['cad-resource:step:l']);
    expect(resourceParts.keys(stub)).toEqual(['cad-resource:step:l']);
    expect(resourceParts.join(stub, parts)).toEqual(record([small, large]));
    // A record without large assets is stored as it is.
    const plain = record([small]);
    expect(resourceParts.split(plain).stub).toBe(plain);
  });

  it('reads a record back whole through the storage', async () => {
    const storage = new IndexedDBStorage<StoredArtifact>(
      `test-${crypto.randomUUID()}`,
      resourceParts,
    );
    const value = record([resource('s', 8), resource('l', resourcePartChars * 2)]);
    await storage.put(value);
    expect(await storage.get('cad-1')).toEqual(value);
    await storage.close();
  });
});

describe('a drawing stores its kept assets and issued PDFs apart too (Codex on #1278, TS-2459)', () => {
  const drawing = () =>
    ({
      id: 'dw-1',
      kind: 'drawing',
      drawingAssets: [resource('a', resourcePartChars), resource('s', 8)],
      drawingIssues: [
        {
          versionId: 'v1',
          issuedAt: '2026-11-14T00:00:00.000Z',
          sheets: [],
          pdf: {
            sha256: 'p',
            byteLength: (resourcePartChars / 4) * 3,
            mediaType: 'application/pdf',
            encoding: 'base64',
            bytes: 'B'.repeat(resourcePartChars),
          },
        },
      ],
      // The same bytes kept as a CAD asset and a drawing asset are two parts.
      cadResources: [resource('a', resourcePartChars)],
    }) as unknown as StoredArtifact;

  it('splits and joins each large payload by its own key', () => {
    const value = drawing();
    const { stub, parts } = resourceParts.split(value);
    expect(stub.drawingAssets!.map((r) => r.bytes)).toEqual(['', 'A'.repeat(8)]);
    expect(stub.drawingIssues![0]!.pdf.bytes).toBe('');
    expect([...parts.keys()].sort()).toEqual([
      'cad-resource:step:a',
      'drawing-asset:step:a',
      'drawing-issue:p',
    ]);
    expect(resourceParts.keys(stub).sort()).toEqual([...parts.keys()].sort());
    expect(resourceParts.join(stub, parts)).toEqual(value);
  });

  it('reads a drawing record back whole through the storage', async () => {
    const storage = new IndexedDBStorage<StoredArtifact>(
      `test-${crypto.randomUUID()}`,
      resourceParts,
    );
    const value = drawing();
    await storage.put(value);
    expect(await storage.get('dw-1')).toEqual(value);
    await storage.close();
  });
});

describe('bytes too long for one IndexedDB value are stored in chunks (#1292, ST-223)', () => {
  const saved = { ...resourceChunks };
  afterEach(() => Object.assign(resourceChunks, saved));
  // Lowered here: the real sizes are 128 Mi and 64 Mi characters.
  const lower = () =>
    Object.assign(resourceChunks, {
      single: 4 * resourcePartChars,
      chars: resourcePartChars * 2,
      legacy: 6 * resourcePartChars,
    });

  // TS-2473
  it("chunks bytes below Chromium's value limit and still reads a part written whole", () => {
    // The real sizes: a 100,000,000-byte asset is 133,333,336 base64 characters, over Chromium's
    // 133,169,152-byte value limit, so it is written in chunks (Codex on #1307).
    const stub = (byteLength: number) => record([{ ...resource('b', 8), byteLength, bytes: '' }]);
    expect(resourceParts.keys(stub(100_000_000))).toEqual([
      'cad-resource:step:b#0',
      'cad-resource:step:b#1',
    ]);
    // Up to 133,169,152 characters a part may also have been written whole before #1292.
    expect(resourceParts.keys(stub(90_000_000))).toEqual([
      'cad-resource:step:b#0',
      'cad-resource:step:b#1',
      'cad-resource:step:b',
    ]);
    expect(resourceParts.keys(stub(60_000_000))).toEqual(['cad-resource:step:b']);
    lower();
    const value = record([resource('w', resourcePartChars * 5)]);
    const { stub: written } = resourceParts.split(value);
    // Written whole by an earlier version: read from the one part.
    expect(
      resourceParts.join(
        written,
        new Map([['cad-resource:step:w', value.cadResources![0]!.bytes]]),
      ),
    ).toEqual(value);
  });

  // TS-2472
  it('splits long bytes into ordered chunks, keeps shorter ones in one part, and joins them', async () => {
    lower();
    // Each 64 Ki run has its own letter, so chunks joined out of order would not match.
    const long = {
      ...resource('l', resourcePartChars * 5),
      bytes: 'ABCDE'
        .split('')
        .map((c) => c.repeat(resourcePartChars))
        .join(''),
    };
    const one = resource('o', resourcePartChars * 4);
    const value = record([long, one]);
    const { stub, parts } = resourceParts.split(value);
    expect([...parts.keys()]).toEqual([
      'cad-resource:step:l#0',
      'cad-resource:step:l#1',
      'cad-resource:step:l#2',
      'cad-resource:step:o',
    ]);
    expect((parts.get('cad-resource:step:l#2') as string).length).toBe(resourcePartChars);
    // Up to `legacy` the part key alone is read too: a part written whole before #1292.
    expect(resourceParts.keys(stub)).toEqual([
      'cad-resource:step:l#0',
      'cad-resource:step:l#1',
      'cad-resource:step:l#2',
      'cad-resource:step:l',
      'cad-resource:step:o',
    ]);
    expect(resourceParts.join(stub, parts)).toEqual(value);
    // A missing chunk leaves the bytes empty, as a missing part does; the asset checks refuse it.
    const torn = new Map(parts);
    torn.delete('cad-resource:step:l#1');
    expect(resourceParts.join(stub, torn).cadResources!.map((r) => r.bytes.length)).toEqual([
      0,
      resourcePartChars * 4,
    ]);
    const storage = new IndexedDBStorage<StoredArtifact>(
      `test-${crypto.randomUUID()}`,
      resourceParts,
    );
    await storage.put(value);
    expect(await storage.get('cad-1')).toEqual(value);
    // Rewritten shorter, the chunks it no longer names are dropped and it reads back whole.
    const shorter = record([one]);
    await storage.put(shorter);
    expect(await storage.get('cad-1')).toEqual(shorter);
    await storage.close();
  });
});

describe('#22 inline images are stored apart from their record', () => {
  const image = (fill: string, chars: number) => `data:image/png;base64,${fill.repeat(chars)}`;
  const design = (draftSrc: string, versionSrcs: string[]) =>
    ({
      id: 'design-1',
      kind: 'design',
      draft: {
        content: { elements: [{ id: 'art', src: draftSrc, provenance: { src: draftSrc } }] },
        baseVersionId: null,
        updatedAt: 't',
      },
      versions: versionSrcs.map((src, i) =>
        Object.freeze({
          versionId: `v${i}`,
          content: {
            elements: [
              { id: 'art', src },
              { id: 'small', src: 'data:image/png;base64,AA' },
            ],
          },
        }),
      ),
    }) as unknown as StoredArtifact;

  it('moves large data URLs out, shares one part between a draft and its version, and joins back', () => {
    const big = image('A', resourcePartChars),
      edited = image('B', resourcePartChars);
    const value = design(big, [big]);
    const { stub, parts } = resourceParts.split(value);
    expect(JSON.stringify(stub).length).toBeLessThan(2000);
    expect([...parts.keys()]).toEqual(['inline-image:v0:0']);
    expect(resourceParts.keys(stub)).toEqual(['inline-image:v0:0']);
    expect(resourceParts.join(stub, parts)).toEqual(value);
    // An edited draft image gets its own part, named by its hash
    const changed = resourceParts.split(design(edited, [big]));
    expect([...changed.parts.keys()].sort()).toEqual(
      ['inline-image:v0:0', expect.stringMatching(/^inline-image:draft:\d+:[0-9a-z]+$/)].sort(),
    );
    expect(resourceParts.split(design(image('C', resourcePartChars), [])).parts.size).toBe(1);
    // Small images stay inline
    const small = design('data:image/png;base64,AA', []);
    expect(resourceParts.split(small).stub).toBe(small);
  });

  it('keeps content that looks like a marker unchanged (Codex on #27)', () => {
    const literals = ['\u0000part:1:literal', '\u0000esc:\u0000part:2:x', '\u0000esc:plain'];
    for (const text of literals) {
      const value = design(text, [text]);
      const { stub, parts } = resourceParts.split(value);
      expect(parts.size).toBe(0);
      expect(resourceParts.keys(stub)).toEqual([]);
      expect(resourceParts.join(stub, parts)).toEqual(value);
    }
    // Next to a real part too.
    const big = image('A', resourcePartChars);
    const value = design(big, [big]);
    (value.draft.content as { elements: { id: string; src: string }[] }).elements.push({
      id: 'note',
      src: literals[0]!,
    });
    const { stub, parts } = resourceParts.split(value);
    expect(resourceParts.keys(stub)).toEqual(['inline-image:v0:0']);
    expect(resourceParts.join(stub, parts)).toEqual(value);
  });

  it('reads a design back whole through the storage, with a missing part as an empty image', async () => {
    const storage = new IndexedDBStorage<StoredArtifact>(
      `test-${crypto.randomUUID()}`,
      resourceParts,
    );
    const value = design(image('A', resourcePartChars * 3), [image('A', resourcePartChars * 3)]);
    await storage.put(value);
    expect(await storage.get('design-1')).toEqual(value);
    const { stub } = resourceParts.split(value);
    const joined = resourceParts.join(stub, new Map());
    expect((joined.draft.content as { elements: { src: string }[] }).elements[0].src).toBe('');
  });
});
