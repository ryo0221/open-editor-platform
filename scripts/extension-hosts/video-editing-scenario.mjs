// A single finite composition, driven entirely through ordinary Host controls.
// Fixtures are supplied explicitly; this is not the large real-device corpus.
import assert from 'node:assert/strict';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function prepareEditingImages(directory, size = 256) {
  assert(path.resolve(directory).startsWith('/tmp/'));
  writeFileSync(
    path.join(directory, 'quadrants.png'),
    readFileSync('tests/fixtures/office/images/quadrants.png'),
  );
  assert([256, 4096].includes(size));
  if (size === 4096)
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      'tests/fixtures/office/images/quadrants.png',
      '-vf',
      'scale=4096:4096',
      '-frames:v',
      '1',
      path.join(directory, 'quadrants.png'),
    ]);
  const jpeg = readFileSync('tests/fixtures/office/images/quadrants.jpeg');
  const app = Buffer.alloc(36);
  app.set([255, 225, 0, 34]);
  app.write('Exif\0\0II', 4, 'ascii');
  app.writeUInt16LE(42, 12);
  app.writeUInt32LE(8, 14);
  app.writeUInt16LE(1, 18);
  app.writeUInt16LE(0x112, 20);
  app.writeUInt16LE(3, 22);
  app.writeUInt32LE(1, 24);
  app.writeUInt16LE(6, 28);
  writeFileSync(
    path.join(directory, 'oriented.jpeg'),
    Buffer.concat([jpeg.subarray(0, 2), app, jpeg.subarray(2)]),
  );
}
export function verifyEditingImages(directory, output) {
  for (const [frame, name, rotate] of [
    [112, 'quadrants.png', false],
    [137, 'oriented.jpeg', true],
  ]) {
    const actual = execFileSync(
      'ffmpeg',
      [
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
      ],
      { maxBuffer: 8 * 1024 ** 2 },
    );
    const expected = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-noautorotate',
        '-i',
        path.join(directory, name),
        '-filter_complex',
        `color=c=black:s=1080x1920:r=25[bg];[0:v]${rotate ? 'transpose=clock,' : ''}scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=rgb`,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        '-',
      ],
      { maxBuffer: 8 * 1024 ** 2 },
    );
    assert.equal(actual.length, expected.length);
    let error = 0;
    for (let i = 0; i < actual.length; i++) error += Math.abs(actual[i] - expected[i]);
    assert(
      error / actual.length < 5,
      `Image frame/orientation mismatch ${name}: ${error / actual.length}`,
    );
  }
}

// Independent decoder and scalar mix oracle; no production renderer/mixer imports.
export function verifyEditingAudio(content, mediaDirectory, output) {
  const decode = (file) =>
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
      { maxBuffer: 8 * 1024 ** 2 },
    );
  const files = new Map(
    ['one.mp4', 'two.mp4', 'music.m4a'].map((name) => {
      const file = path.join(mediaDirectory, name);
      return [createHash('sha256').update(readFileSync(file)).digest('hex'), file];
    }),
  );
  const pcm = new Map(
    content.sources
      .filter((s) => !('kind' in s))
      .map((s) => [s.id, decode(files.get(s.asset.sha256))]),
  );
  const seconds = (t) => t.value / t.timescale;
  const sample = (t) => {
    const result = seconds(t) * 48000;
    assert(Number.isInteger(result));
    return result;
  };
  const expected = new Float64Array(sample(content.sequence.duration));
  for (const c of content.sequence.clips.filter((c) => c.kind === 'audio')) {
    if (!content.sequence.tracks.find((t) => t.id === c.trackId).enabled) continue;
    const start = sample(c.start),
      end = start + sample(c.duration);
    for (let i = start; i < end; i++) {
      const sourceIndex = sample(c.sourceIn) + i - start;
      const at = sourceIndex / 48000,
        f = c.fade;
      let gain = at >= seconds(f.start) && at < seconds(f.end) ? 1 : 0;
      if (f.in.value) gain = Math.min(gain, (at - seconds(f.start)) / seconds(f.in));
      if (f.out.value) gain = Math.min(gain, (seconds(f.end) - at) / seconds(f.out));
      expected[i] += pcm.get(c.sourceId).readFloatLE(sourceIndex * 4) * c.gain * Math.max(0, gain);
    }
  }
  const actual = decode(output);
  assert(actual.length >= expected.length * 4);
  // Same existing AVC/AAC functional bounds, including J/L, split and tail windows.
  const ranges = [
    [0, expected.length],
    [0, 240],
    [53760, 54240],
    [143760, 144240],
    [expected.length - 240, expected.length],
  ];
  const results = ranges.map(([start, end]) => {
    let max = 0,
      sum = 0;
    for (let i = start; i < end; i++) {
      const error = actual.readFloatLE(i * 4) - expected[i];
      assert(Number.isFinite(error));
      max = Math.max(max, Math.abs(error));
      sum += error ** 2;
    }
    const rms = Math.sqrt(sum / (end - start));
    assert(max < 0.1 && rms < 0.03, JSON.stringify({ start, end, max, rms }));
    return { start, end, max, rms };
  });
  assert(
    expected.some((v) => v !== 0),
    'Oracle must contain music/source audio',
  );
  return results;
}

export async function exerciseEditingScenario(page, mediaDirectory) {
  const click = (name) => page.getByRole('button', { name, exact: true }).click();
  const native = async () => JSON.parse(await page.locator('#native').textContent());
  const resize = async (n) => {
    await page.locator('#duration').fill(String(n));
    await click('Resize sequence');
  };
  const trim = async (id, start, end) => {
    await page.selectOption('#selected', id);
    await page.locator('#trim-start').fill(String(start));
    await page.locator('#trim-end').fill(String(end));
    await click('Trim selected clip');
  };
  const original = async (name) => {
    await page.locator('#import').setInputFiles(path.join(mediaDirectory, name));
    await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 60000 });
  };
  // Four-second story: native introduction, first shot, then second shot.
  await trim((await native()).sequence.clips[0].id, 0, 1);
  await resize(1);
  await original('one.mp4');
  const first = (await native()).sequence.clips.filter((c) => c.kind !== 'animation');
  for (const c of first) await trim(c.id, 1, 2);
  await resize(2);
  await original('two.mp4');
  const second = (await native()).sequence.clips.filter(
    (c) => c.kind !== 'animation' && !first.some((f) => f.id === c.id),
  );
  for (const c of second) await trim(c.id, 2, 4);
  await resize(5);
  const beforeGap = await native();
  await page.locator('#at').fill('2');
  await page.locator('#ripple-gap').fill('1');
  await click('Insert gap on all tracks at split / move time');
  const withGap = await native();
  for (const c of second)
    assert.deepEqual(withGap.sequence.clips.find((x) => x.id === c.id).start, {
      value: 3,
      timescale: 1,
    });
  await click('Undo');
  assert.deepEqual(await native(), beforeGap);
  await click('Redo');
  assert.deepEqual(await native(), withGap);
  await page.locator('#trim-start').fill('2');
  await page.locator('#trim-end').fill('3');
  await click('Ripple delete trim range on all tracks');
  assert.deepEqual(await native(), beforeGap);
  await resize(4);
  // Independent audio trim is a J/L edit: video is unchanged and audio starts later.
  await trim(first.find((c) => c.kind === 'audio').id, '9/8', 2);
  const video = first.find((c) => c.kind === 'video');
  assert.deepEqual((await native()).sequence.clips.find((c) => c.id === video.id).start, {
    value: 1,
    timescale: 1,
  });
  await page.selectOption('#selected', video.id);
  await page.locator('#fade-in').fill('1/4');
  await page.locator('#fade-out').fill('1/4');
  const beforeVisual = await native();
  await click('Set visual fades');
  const faded = await native();
  assert(faded.sequence.clips.find((c) => c.id === video.id).visualFade);
  await click('Undo');
  assert.deepEqual(await native(), beforeVisual);
  await click('Redo');
  assert.deepEqual(await native(), faded);
  await page.selectOption('#selected', second.find((c) => c.kind === 'video').id);
  await page.locator('#at').fill('3');
  const beforeSplit = await native();
  await click('Split linked clips');
  assert.equal((await native()).sequence.clips.length, beforeSplit.sequence.clips.length + 2);
  await click('Undo');
  assert.deepEqual(await native(), beforeSplit);
  await click('Redo');
  await click('Unlink selected group');
  assert.equal(
    (await native()).sequence.clips.find((c) => c.id === second[0].id).linkGroupId,
    undefined,
  );
  await page.selectOption('#import-kind', 'aac-mono-v2');
  await page.locator('#audio-start').fill('0');
  await original('music.m4a');
  const music = (await native()).sequence.clips.find((c) => c.trackId === 'music');
  await trim(music.id, 0, 4);
  await resize(4);
  await page.selectOption('#selected', music.id);
  await page.locator('#gain').fill('20');
  await click('Set volume');
  await page.locator('#fade-in').fill('1/4');
  await page.locator('#fade-out').fill('1/4');
  await click('Set fades');
  const completed = await native();
  assert.deepEqual(
    completed.sequence.clips.find((c) => c.id === video.id).visualFade,
    faded.sequence.clips.find((c) => c.id === video.id).visualFade,
    'Importing music and changing audio gain/fades must retain visual effects',
  );
  // The same all-track operation now crosses the music clip: reject atomically.
  await page.locator('#at').fill('2');
  await click('Insert gap on all tracks at split / move time');
  await expect(page.locator('#status')).toContainText('Crossing ripple clip unsupported');
  assert.deepEqual(await native(), completed);
  await page.selectOption('#import-kind', 'image-v3');
  await original('quadrants.png');
  const png = (await native()).sequence.clips.find((c) => c.kind === 'image');
  await page.selectOption('#selected', png.id);
  await page.locator('#at').fill('9/2');
  const beforeImageSplit = await native();
  await click('Split linked clips');
  assert.equal((await native()).sequence.clips.filter((c) => c.kind === 'image').length, 2);
  await click('Undo');
  assert.deepEqual(await native(), beforeImageSplit);
  await click('Redo');
  await original('oriented.jpeg');
  assert.deepEqual((await native()).sequence.duration, { value: 6, timescale: 1 });
  // Reuse the same PNG original as an explicit overlay, not a separate timeline.
  await original('quadrants.png');
  const overlay = (await native()).sequence.clips.at(-1);
  await click('Add visual track');
  const overlayTrack = await page.locator('#visual-track').inputValue();
  await click('Undo');
  assert(
    !(
      await page
        .locator('#visual-track option')
        .evaluateAll((options) => options.map((o) => o.value))
    ).includes(overlayTrack),
  );
  await click('Redo');
  await page.selectOption('#visual-track', overlayTrack);
  await page.selectOption('#selected', overlay.id);
  await click('Move selected visual clip to track');
  await page.locator('#at').fill('-19/4');
  await click('Move linked clips');
  await resize(6);
  const layered = await native();
  await page.locator('#preview-frame').fill('37');
  await click('Preview frame');
  await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 60000 });
  const upper = await page.locator('#preview').evaluate((canvas) => canvas.toDataURL());
  await click('Lower visual track');
  await click('Preview frame');
  await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 60000 });
  assert.notEqual(await page.locator('#preview').evaluate((canvas) => canvas.toDataURL()), upper);
  await click('Undo');
  assert.deepEqual(await native(), layered);
  await click('Preview frame');
  await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 60000 });
  assert.equal(await page.locator('#preview').evaluate((canvas) => canvas.toDataURL()), upper);
  await click('Play');
  await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 60000 });
  const playback = JSON.parse(await page.locator('#playback-debug').textContent());
  assert.equal(playback.initialFrame.frame, 37);
  assert.equal(playback.state, 'ended');
}

/** Independent source decode, black contain background, and alpha source-over at t=1.48. */
export function verifyEditingComposite(directory, output) {
  const actual = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      output,
      '-vf',
      'select=eq(n\\,37)',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 8 * 1024 ** 2 },
  );
  const expected = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      '0.48',
      '-i',
      path.join(directory, 'one.mp4'),
      '-i',
      path.join(directory, 'quadrants.png'),
      '-filter_complex',
      'color=c=black:s=1080x1920:r=25[bg];[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[video];[bg][video]overlay=(W-w)/2:(H-h)/2:format=rgb[base];[1:v]scale=1080:1920:force_original_aspect_ratio=decrease[png];[base][png]overlay=(W-w)/2:(H-h)/2:format=rgb',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 8 * 1024 ** 2 },
  );
  assert.equal(actual.length, expected.length);
  let error = 0;
  for (let i = 0; i < actual.length; i++) error += Math.abs(actual[i] - expected[i]);
  assert(
    error / actual.length < 5,
    `Track-order alpha composite mismatch: ${error / actual.length}`,
  );
  return { frame: 37, meanRgbError: error / actual.length };
}
