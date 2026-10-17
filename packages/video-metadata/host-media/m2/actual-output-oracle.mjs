/** Verification only: native declarations + native tools, no production time/PCM/reader imports. */
import assert from 'node:assert/strict';
import { verifyVideoPresentation } from './output-timing-oracle.mjs';
import { execFileSync } from 'node:child_process';
const run = (tool, args, maxBuffer = 32 * 1024 ** 2) => execFileSync(tool, args, { maxBuffer });
const probe = (file, args = ['-show_streams']) =>
  JSON.parse(run('ffprobe', ['-v', 'error', ...args, '-of', 'json', file]));
const q = (t) => [BigInt(t.value), BigInt(t.timescale)];
const add = (a, b) => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
const sub = (a, b) => add(a, [-b[0], b[1]]);
const mul = (a, b) => [a[0] * b[0], a[1] * b[1]];
const cmp = (a, b) => a[0] * b[1] - b[0] * a[1];
const num = (a) => Number(a[0]) / Number(a[1]);
const sample = (t) => {
  const n = t[0] * 48000n;
  assert.equal(n % t[1], 0n, 'Oracle requires exact 48k sample position');
  return Number(n / t[1]);
};
export function verifyActualOutput(native, filesByHash, output, canvas) {
  assert.deepEqual(native.sequence.duration, { value: 4, timescale: 1 });
  const meta = probe(output),
    v = meta.streams.find((s) => s.codec_type === 'video'),
    a = meta.streams.find((s) => s.codec_type === 'audio');
  assert.equal(v.width, canvas.width);
  assert.equal(v.height, canvas.height);
  assert.equal(v.nb_frames, '100');
  assert.equal(v.duration, '4.000000');
  assert.equal(a.channels, 1);
  assert.equal(a.sample_rate, '48000');
  // Prove the presentation interval before interpreting decoded samples beyond it.
  assert.equal(a.time_base, '1/48000');
  assert.equal(a.start_pts, 0, 'Encoded audio presentation must start at zero');
  assert.equal(a.duration_ts, 192000, 'Encoded audio presentation must end at four seconds');
  assert.equal(a.start_time, '0.000000');
  assert.equal(a.duration, '4.000000');
  const audioPresentation = {
    timeBase: a.time_base,
    startPts: a.start_pts,
    durationTs: a.duration_ts,
    startTime: a.start_time,
    duration: a.duration,
    sampleRate: a.sample_rate,
    channels: a.channels,
  };
  const packets = probe(output, [
    '-select_streams',
    'v:0',
    '-show_packets',
    '-show_entries',
    'packet=pts,dts,duration',
  ]).packets;
  const frames = probe(output, [
    '-select_streams',
    'v:0',
    '-show_frames',
    '-show_entries',
    'frame=pts,best_effort_timestamp,duration',
  ]).frames;
  const videoPresentation = verifyVideoPresentation(v, packets, frames);
  // Metadata-only controls: decoder-order packets may reorder, presentation times may not drift.
  verifyVideoPresentation(v, [...packets].reverse(), frames);
  const changed = (items, key) =>
    items.map((item, n) => (n === 50 ? { ...item, [key]: item[key] + 1 } : item));
  assert.throws(() => verifyVideoPresentation({ ...v, start_pts: 1 }, packets, frames));
  assert.throws(() => verifyVideoPresentation(v, changed(packets, 'pts'), frames));
  assert.throws(() => verifyVideoPresentation(v, changed(packets, 'duration'), frames));
  assert.throws(() => verifyVideoPresentation(v, packets, changed(frames, 'pts')));
  assert.throws(() => verifyVideoPresentation(v, packets, changed(frames, 'duration')));
  const timingControls = {
    packetReorderingAccepted: true,
    nonzeroStartRejected: true,
    intermediatePacketPtsRejected: true,
    intermediatePacketDurationRejected: true,
    intermediateFramePtsRejected: true,
    intermediateFrameDurationRejected: true,
  };
  const enabled = new Set(native.sequence.tracks.filter((t) => t.enabled).map((t) => t.id));
  const decoded = new Map(),
    indexes = new Map(),
    sourceEvidence = [];
  for (const source of native.sources) {
    const file = filesByHash.get(source.asset.sha256);
    assert(file, 'Missing independently bound original');
    const metadata = probe(file),
      audio = metadata.streams.find((s) => s.codec_type === 'audio');
    assert.equal(Number(audio.start_time), 0, 'FFmpeg presentation PCM must begin at zero');
    assert.equal(audio.channels, 1);
    decoded.set(
      source.id,
      run('ffmpeg', [
        '-v',
        'error',
        '-i',
        file,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-f',
        'f32le',
        '-',
      ]),
    );
    const video = metadata.streams.find((s) => s.codec_type === 'video');
    if (video) {
      assert.equal(video.time_base, '1/600');
      const packets = probe(file, [
        '-select_streams',
        'v:0',
        '-show_packets',
        '-show_entries',
        'packet=pts,duration',
      ]).packets;
      indexes.set(source.id, packets);
      sourceEvidence.push({
        sha256: source.asset.sha256,
        timeBase: video.time_base,
        width: video.width,
        height: video.height,
        rotation: video.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? 0,
      });
    }
  }
  const actual = run('ffmpeg', [
    '-v',
    'error',
    '-i',
    output,
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    '-',
  ]);
  const count = 192000;
  assert(actual.length >= count * 4);
  const expected = new Float64Array(count);
  for (const clip of native.sequence.clips.filter(
    (c) => c.kind === 'audio' && enabled.has(c.trackId),
  )) {
    const start = sample(q(clip.start)),
      end = sample(add(q(clip.start), q(clip.duration))),
      offset = sample(sub(q(clip.sourceIn), q(clip.start)));
    const pcm = decoded.get(clip.sourceId);
    for (let k = start; k < end; k++) {
      assert(k >= 0 && k < count);
      const index = k + offset;
      assert(index >= 0 && index * 4 + 4 <= pcm.length);
      const st = add(q(clip.sourceIn), sub([BigInt(k), 48000n], q(clip.start))),
        f = clip.fade;
      let envelope = 1;
      if (cmp(st, q(f.start)) < 0n || cmp(st, q(f.end)) >= 0n) envelope = 0;
      else {
        if (f.in.value) envelope = Math.min(envelope, num(sub(st, q(f.start))) / num(q(f.in)));
        if (f.out.value) envelope = Math.min(envelope, num(sub(q(f.end), st)) / num(q(f.out)));
      }
      expected[k] += pcm.readFloatLE(index * 4) * clip.gain * Math.max(0, envelope);
    }
  }
  const ranges = [
    [0, count],
    [0, 256],
    [47, 49],
    [95872, 96128],
    [191951, 191953],
    [191744, count],
  ];
  const audio = ranges.map(([first, end]) => {
    let max = 0,
      squares = 0;
    for (let k = first; k < end; k++) {
      const value = actual.readFloatLE(k * 4);
      assert(Number.isFinite(value));
      const d = value - expected[k];
      max = Math.max(max, Math.abs(d));
      squares += d * d;
    }
    return { first, end, samples: end - first, max, rms: Math.sqrt(squares / (end - first)) };
  });
  for (const range of audio)
    assert(range.max < 0.1 && range.rms < 0.03, `Encoded actual PCM ${JSON.stringify(range)}`);
  const pictures = [];
  for (const frame of [0, 1, 49, 50, 51, 99]) {
    const at = [BigInt(frame), 25n];
    const clips = native.sequence.clips.filter(
      (c) =>
        c.kind === 'video' &&
        enabled.has(c.trackId) &&
        cmp(at, q(c.start)) >= 0n &&
        cmp(at, add(q(c.start), q(c.duration))) < 0n,
    );
    assert.equal(clips.length, 1);
    const clip = clips[0],
      source = native.sources.find((s) => s.id === clip.sourceId),
      stream = source.streams.find((s) => s.id === clip.streamId);
    const sourceTime = add(q(clip.sourceIn), mul(sub(at, q(clip.start)), q(clip.rate))),
      raw = sub(sourceTime, q(stream.presentationOrigin));
    const packets = indexes
      .get(source.id)
      .filter(
        (p) =>
          cmp([BigInt(p.pts), 600n], raw) <= 0n &&
          cmp(raw, [BigInt(p.pts + p.duration), 600n]) < 0n,
      );
    assert.equal(packets.length, 1);
    const pts = packets[0].pts,
      file = filesByHash.get(source.asset.sha256);
    const expectedPicture = run('ffmpeg', [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(pts\\,${pts}),scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:color=${canvas.background.replace('#', '0x')}`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ]);
    const picture = run('ffmpeg', [
      '-v',
      'error',
      '-i',
      output,
      '-vf',
      `select=eq(n\\,${frame})`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ]);
    assert.equal(expectedPicture.length, canvas.width * canvas.height * 3);
    assert.equal(picture.length, expectedPicture.length);
    let total = 0;
    for (let i = 0; i < picture.length; i++) total += Math.abs(picture[i] - expectedPicture[i]);
    const mean = total / picture.length;
    assert(mean < 8, `Actual contain pixels ${frame}/${mean}`);
    pictures.push({
      frame,
      sourceHash: source.asset.sha256,
      sourceTime: num(sourceTime),
      rawTime: num(raw),
      pts,
      scale: 600,
      mean,
    });
  }
  return {
    audio,
    audioPresentation,
    videoPresentation,
    timingControls,
    validSamples: count,
    decodedSamples: actual.length / 4,
    trailingBeyondNativeEndpoint: actual.length / 4 - count,
    pictures,
    sourceEvidence,
    thresholds: { audioMax: 0.1, audioRms: 0.03, pixelMean: 8 },
  };
}
