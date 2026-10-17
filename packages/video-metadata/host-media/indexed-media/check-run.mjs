import { resourceCheck } from './resource-check.mjs';
import { indexFaults } from './faults.mjs';
import { createPcmFile } from './pcm-file.mjs';
import { createVideoWindow, videoStatus } from './video-window.mjs';
import { scratchStatus } from './scratch.mjs';
import { time } from '@editor-platform/video-core';
const need = (ok, msg) => {
  if (!ok) throw Error(msg);
};
globalThis.checkIndexed = async (originalHash) => {
  const original = globalThis.document.querySelector('#source').files[0];
  original.arrayBuffer = () => {
    throw Error('Whole original read forbidden');
  };
  const caller = new globalThis.AbortController(),
    identity = { originalHash, streamId: '2', decodePolicy: 'native-aac-continuous-v0' };
  const resourceChecks = await resourceCheck(original, identity);
  const index = await createPcmFile(original, caller.signal, identity),
    windows = [];
  for (const [relativeFirst, length] of [
    [0, 128],
    [48000 * 45 + 11000, 1024],
    [48000 * 46 + 34000, 1024],
    [48000 * 48 - 256, 256],
    [48000, 512],
  ]) {
    const first = index.valid.first + relativeFirst,
      window = await index.decode(
        { first, end: first + length, rate: 48000, channels: 2 },
        caller.signal,
      ),
      samples = [];
    for (let i = 0; i < length; i++) samples.push(window.planes[0][i], window.planes[1][i]);
    windows.push({ relativeFirst, samples });
  }
  const video = await createVideoWindow(original, caller.signal),
    canvas = globalThis.document.querySelector('#frame'),
    context = canvas.getContext('2d'),
    frames = [];
  for (const seconds of [45.24, 46.72, 1.24, 47.96]) {
    const raw = time(Math.round(seconds * 100), 100); // Source video edit origin is checked below from saved clocks.
    const sourceTime = time(
      raw.value * video.clock.scale + video.clock.mediaStart * raw.timescale,
      raw.timescale * video.clock.scale,
    );
    const row = await video.frameAt(sourceTime, caller.signal);
    context.drawImage(row.frame, 0, 0, 320, 180);
    const pixel = Array.from(context.getImageData(100, 80, 1, 1).data);
    frames.push({ seconds, pts: row.pts, scale: video.clock.scale, pixel });
    row.release();
    need(
      seconds < 47
        ? seconds < 3
          ? pixel[2] > 200
          : pixel[1] > 80 && pixel[0] < 30 && pixel[2] < 30
        : pixel.slice(0, 3).every((x) => x > 220),
      'GOP frame marker',
    );
  }
  const videoEvidence = { ...video.evidence };
  const point = (seconds) =>
    time(seconds * video.clock.scale + video.clock.mediaStart, video.clock.scale);
  const [firstFrame, secondFrame] = await Promise.all([
    video.frameAt(point(1), caller.signal),
    video.frameAt(point(47), caller.signal),
  ]);
  need(
    firstFrame.frame.displayWidth === 320 && secondFrame.frame.displayWidth === 320,
    'Cross GOP closed returned frame',
  );
  let thirdFrameRefused = false;
  try {
    await video.frameAt(point(2), caller.signal);
  } catch (e) {
    thirdFrameRefused = String(e).includes('admission');
  }
  need(thirdFrameRefused, 'Outstanding frame lease bound');
  let videoDrained = false;
  const videoDisposal = video.dispose().then(() => {
    videoDrained = true;
  });
  await new Promise((r) => globalThis.setTimeout(r, 0));
  need(!videoDrained, 'Frame leases ignored during drain');
  firstFrame.release();
  secondFrame.release();
  await videoDisposal;
  const lease = index.acquire();
  const originalRead = globalThis.Blob.prototype.arrayBuffer;
  let releaseReads;
  const readGate = new Promise((resolve) => {
    releaseReads = resolve;
  });
  globalThis.Blob.prototype.arrayBuffer = async function () {
    if (this.size === 8192) await readGate;
    return originalRead.call(this);
  };
  const plan = {
    first: index.valid.first,
    end: index.valid.first + 1024,
    rate: 48000,
    channels: 2,
  };
  const readA = lease.decode(plan, caller.signal),
    readB = lease.decode(plan, caller.signal);
  let thirdReadRefused = false;
  try {
    await lease.decode(plan, caller.signal);
  } catch (e) {
    thirdReadRefused = String(e).includes('concurrent read');
  }
  need(thirdReadRefused && scratchStatus().reads === 2, 'Concurrent read bound');
  let settled = false;
  const dispose = index.dispose().then(() => {
    settled = true;
  });
  await new Promise((r) => globalThis.setTimeout(r, 0));
  const leaseDrainHeld = !settled;
  releaseReads();
  await Promise.all([readA, readB]);
  globalThis.Blob.prototype.arrayBuffer = originalRead;
  need(!settled, 'Live lease was ignored');
  lease.release();
  await dispose;
  const successor = await createPcmFile(original, caller.signal, identity);
  await index.dispose();
  const probe = await successor.decode(
    { first: successor.valid.first, end: successor.valid.first + 1, rate: 48000, channels: 2 },
    caller.signal,
  );
  const oldCleanupKeptNew =
    probe.planes[0].length === 1 && successor.identity.generation !== index.identity.generation;
  await successor.dispose();
  const faults = await indexFaults(original, identity);
  return {
    faults,
    videoBudget: videoStatus(),
    identity: index.identity,
    pcm: index.evidence,
    video: videoEvidence,
    frames,
    windows,
    resourceChecks,
    thirdFrameRefused,
    zeroWholeOriginalReads: true,
    leaseDrainHeld,
    thirdReadRefused,
    oldCleanupKeptNew,
    finalBudget: scratchStatus(),
  };
};
