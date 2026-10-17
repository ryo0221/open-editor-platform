import { time, subtract, videoCommandV2 } from '@editor-platform/video-core';
import { contentHash } from '@editor-platform/artifact-core';
import { inspectMediaOriginalV2, prepareAvImportV2 } from './media-profile-v2';
import { prepareAudioImportV2 } from './audio-import-v2';
import { createMixedPcmV2 } from './mixed-pcm-v2.mjs';
import { scratchStatus } from '../indexed-media/scratch.mjs';
const need = (ok, msg) => {
  if (!ok) throw Error(msg);
};
globalThis.runMixedPcmV2 = async (hashes) => {
  const files = [...globalThis.document.querySelector('input').files],
    signal = new globalThis.AbortController().signal;
  for (const file of files)
    file.arrayBuffer = () => {
      throw Error('Whole original buffer prohibited');
    };
  let v = {
    schema: 'video-core-prototype-v2',
    sources: [],
    sequence: {
      id: 'sequence',
      duration: time(0),
      frameRate: time(25),
      tracks: [
        { id: 'visual', kind: 'visual', enabled: true, locked: false },
        { id: 'audio', kind: 'audio', enabled: true, locked: false },
        { id: 'music', kind: 'audio', enabled: true, locked: false },
      ],
      clips: [],
    },
  };
  const map = new Map(files.map((f, i) => [hashes[i], f]));
  const asset = (i) => ({
    assetId: 'sha256:' + hashes[i],
    sha256: hashes[i],
    byteLength: files[i].size,
  });
  const edit = (e) => {
    v = videoCommandV2(e).apply(v);
  };
  const one = await inspectMediaOriginalV2(files[0], 'av-sdr-v2', signal);
  v = prepareAvImportV2(v, one.plan, asset(0), 'one');
  const tail = subtract(v.sequence.duration, time(2));
  for (const id of ['one:1', 'one:2'])
    edit({ type: 'trim', clipId: id, start: tail, end: v.sequence.duration, independent: true });
  edit({ type: 'move', clipId: 'one:1', delta: subtract(time(0), tail) });
  edit({ type: 'resize', duration: time(2) });
  const two = await inspectMediaOriginalV2(files[1], 'av-sdr-v2', signal);
  v = prepareAvImportV2(v, two.plan, asset(1), 'two');
  for (const id of ['two:1', 'two:2'])
    edit({
      type: 'trim',
      clipId: id,
      start: time(2001, 1000),
      end: time(4001, 1000),
      independent: true,
    });
  edit({ type: 'move', clipId: 'two:1', delta: time(-1, 1000) });
  edit({ type: 'resize', duration: time(4) });
  const music = await inspectMediaOriginalV2(files[2], 'aac-mono-v2', signal);
  music.plan.streams[0].destination = 'music';
  v = prepareAudioImportV2(v, music.plan, asset(2), 'bgm', time(1, 1000));
  edit({
    type: 'trim',
    clipId: 'bgm:1',
    start: time(1, 1000),
    end: time(3999, 1000),
    independent: true,
  });
  edit({ type: 'resize', duration: time(4) });
  for (const id of ['one:2', 'two:2']) {
    edit({ type: 'gain', clipId: id, gain: 0.25 });
    edit({ type: 'fade', clipId: id, fadeIn: time(1, 10), fadeOut: time(1, 10) });
  }
  edit({ type: 'gain', clipId: 'bgm:1', gain: 0.2 });
  edit({ type: 'fade', clipId: 'bgm:1', fadeIn: time(1, 2), fadeOut: time(1, 2) });
  const before = await contentHash(v),
    output = new Float32Array(192000),
    owner = await createMixedPcmV2(v, map, signal);
  let evidence;
  try {
    const sizes = [1, 127, 4096, 997];
    let step = 0;
    for (let first = 0; first < output.length; ) {
      const end = Math.min(output.length, first + sizes[step++ % sizes.length]);
      const block = await owner.render(first, end, signal);
      try {
        output.set(block.planes[0], first);
      } finally {
        block.release();
      }
      first = end;
    }
    const cut = await owner.render(95800, 96200, signal);
    need(
      cut.planes[0].every((value, i) => value === output[95800 + i]),
      'Seek/chunk mix changed',
    );
    cut.release();
    evidence = owner.evidence;
    const pending = owner.render(0, 4096, signal);
    const refused = pending.then(
      () => false,
      () => true,
    );
    await owner.dispose();
    need(await refused, 'Disposed render published');
  } finally {
    await owner.dispose();
  }
  need((await contentHash(v)) === before, 'Render changed native');
  need(scratchStatus().files === 0, 'Mix drain leaked');
  const invalid = globalThis.structuredClone(v);
  invalid.sources[1].asset.sha256 = 'f'.repeat(64);
  const wrong = new Map(map);
  wrong.set('f'.repeat(64), files[1]);
  let failed;
  try {
    const candidate = await createMixedPcmV2(invalid, wrong, signal);
    await candidate.dispose();
  } catch (e) {
    failed = String(e);
  }
  need(failed?.includes('original SHA'), 'Wrong immutable source admitted');
  need(scratchStatus().files === 0, 'Partial preparation leaked');
  return {
    native: v,
    nativeHash: before,
    pcm: Array.from(output),
    evidence,
    after: scratchStatus(),
    partialPreparationRefused: failed,
    disposedRenderRefused: true,
  };
};
