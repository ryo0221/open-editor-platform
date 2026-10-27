import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { contentHash } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { assertVideoContentV3, time, videoCommandV3 } from '@editor-platform/video-core';
import { inspectImageBytesV3, prepareImageImportV3, type VisualImportSetV3 } from './image-source';
import {
  emptyV2Fixture,
  v0EmptyFixture,
  v2Fixture,
} from '../file-backed-storage/portable/v2-fixture';
import { createPortableProjects } from '../file-backed-storage/portable/versioned';
import { scan, memory } from '../file-backed-storage/io';
import { createZip } from '../file-backed-storage/portable/zip64';
const signal = () => new AbortController().signal;
const png = () => new Uint8Array(readFileSync('tests/fixtures/office/images/quadrants.png'));
function example() {
  const bytes = png(),
    hash = createHash('sha256').update(bytes).digest('hex');
  const plan = inspectImageBytesV3(bytes);
  const content = prepareImageImportV3(
    { ...emptyV2Fixture(), schema: 'video-core-prototype-v3' },
    plan,
    { assetId: 'sha256:' + hash, sha256: hash, byteLength: bytes.length },
    'image',
  );
  return { bytes, hash, plan, content };
}
it('uses image-native clips and normal source-time editing/Undo without copying bytes into content', () => {
  const { content } = example();
  const original = JSON.stringify(content),
    session = new EditorSession(content);
  session.execute(
    videoCommandV3({
      type: 'split',
      clipId: 'image:image',
      at: time(1, 2),
      rightIds: { 'image:image': 'right' },
    }),
  );
  expect(session.content.sequence.clips.map((c) => c.kind)).toEqual(['image', 'image']);
  expect(session.content.sequence.clips[1].sourceIn).toEqual(time(1, 2));
  session.undo();
  expect(JSON.stringify(session.content)).toBe(original);
  const malformed = structuredClone(content);
  malformed.sources[0].id = 'visual';
  expect(() => assertVideoContentV3(malformed)).toThrow('Duplicate');
  const locked = structuredClone(content);
  locked.sequence.tracks[0].locked = true;
  expect(() =>
    videoCommandV3({ type: 'move', clipId: 'image:image', delta: time(1) }).apply(locked),
  ).toThrow('Locked');
});
it('retains exact image originals through portable save/read and refuses missing or mismatched closure', async () => {
  const { content, bytes, hash, plan } = example(),
    old = await v0EmptyFixture(),
    h = await contentHash(content);
  const project = {
    ...old,
    versions: old.versions.map((v) => ({ ...v, content, contentHash: h })),
    capture: { ...old.capture, contentHash: h },
    plans: [{ sourceId: 'image', plan: plan as VisualImportSetV3 }],
    originals: new Map([[hash, memory(bytes)]]),
  };
  const portable = createPortableProjects(scan),
    chunks: Uint8Array[] = [];
  await createZip(scan).writeZip(
    await portable.v3.prepareProject(project, signal()),
    {
      write: async (b) => {
        chunks.push(Uint8Array.from(b));
      },
    },
    signal(),
  );
  const result = await portable.v3.openProject(
    memory(Uint8Array.from(Buffer.concat(chunks))),
    signal(),
  );
  expect(result.versions[0].content).toEqual(content);
  expect(await scan(result.originals.get(hash)!, signal())).toEqual(
    await scan(memory(bytes), signal()),
  );
  await expect(
    portable.v3.prepareProject({ ...project, originals: new Map() }, signal()),
  ).rejects.toThrow('Missing');
  await expect(
    portable.v3.prepareProject(
      { ...project, plans: [{ sourceId: 'image', plan: { ...plan, width: plan.width + 1 } }] },
      signal(),
    ),
  ).rejects.toThrow('mismatch');
});
it('rejects unsupported/truncated/oversized image headers before decoder allocation', () => {
  expect(() => inspectImageBytesV3(png().slice(0, 30))).toThrow();
  const huge = png();
  new DataView(huge.buffer).setUint32(16, 65535);
  expect(() => inspectImageBytesV3(huge)).toThrow();
  const depth = png();
  depth[24] = 16;
  expect(() => inspectImageBytesV3(depth)).toThrow('8-bit');
  const original = png(),
    at = 33;
  const animated = new Uint8Array(original.length + 20);
  animated.set(original.subarray(0, at));
  new DataView(animated.buffer).setUint32(at, 8);
  animated.set(new TextEncoder().encode('acTL'), at + 4);
  animated.set(original.subarray(at), at + 20);
  expect(() => inspectImageBytesV3(animated)).toThrow('animated');
});
it('retains JPEG EXIF orientation as metadata without rewriting original bytes', () => {
  const jpeg = new Uint8Array(readFileSync('tests/fixtures/office/images/quadrants.jpeg'));
  const app = new Uint8Array(36),
    v = new DataView(app.buffer);
  app.set([255, 225, 0, 34]);
  app.set(new TextEncoder().encode('Exif\0\0II'), 4);
  v.setUint16(12, 42, true);
  v.setUint32(14, 8, true);
  v.setUint16(18, 1, true);
  v.setUint16(20, 0x112, true);
  v.setUint16(22, 3, true);
  v.setUint32(24, 1, true);
  v.setUint16(28, 6, true);
  const oriented = new Uint8Array(jpeg.length + app.length);
  oriented.set(jpeg.subarray(0, 2));
  oriented.set(app, 2);
  oriented.set(jpeg.subarray(2), 2 + app.length);
  const before = oriented.slice();
  expect(inspectImageBytesV3(oriented).orientation).toBe(6);
  expect(oriented).toEqual(before);
});

it('keeps stream IDs scoped to each AV source when importing an image', async () => {
  const media = (await v2Fixture(scan)).versions[0].content;
  const { plan, content } = example();
  const result = prepareImageImportV3(
    { ...media, schema: 'video-core-prototype-v3' },
    plan,
    content.sources[0].asset,
    'still',
  );
  expect(result.sources).toHaveLength(media.sources.length + 1);
  expect(() => assertVideoContentV3(result)).not.toThrow();
});
it('refuses auxiliary JPEG profiles and unsupported coding processes before decode', () => {
  const original = new Uint8Array(readFileSync('tests/fixtures/office/images/quadrants.jpeg'));
  const auxiliary = new Uint8Array(original.length + 4);
  auxiliary.set(original.subarray(0, 2));
  auxiliary.set([255, 235, 0, 2], 2);
  auxiliary.set(original.subarray(2), 6);
  expect(() => inspectImageBytesV3(auxiliary)).toThrow('auxiliary');
  const lossless = original.slice();
  const at = lossless.findIndex((b, i) => b === 255 && [192, 193, 194].includes(lossless[i + 1]));
  expect(at).toBeGreaterThan(0);
  lossless[at + 1] = 195;
  expect(() => inspectImageBytesV3(lossless)).toThrow('coding process');
});

it('refuses unknown clip kinds rather than dropping them from the media projection', () => {
  const { content } = example();
  const malformed = structuredClone(content) as unknown as {
    sequence: { clips: { kind: string }[] };
  };
  malformed.sequence.clips[0].kind = 'unsupported';
  expect(() => assertVideoContentV3(malformed)).toThrow('Unsupported v3 clip kind');
});
