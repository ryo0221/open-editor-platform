import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect } from '@playwright/test';
export async function exerciseDissolveScenario(page) {
  const click = (name) => page.getByRole('button', { name, exact: true }).click();
  const native = async () => JSON.parse(await page.locator('#native').textContent());
  const initial = await native();
  const videos = initial.sequence.clips
    .filter((c) => c.kind === 'video')
    .sort((a, b) => a.start.value / a.start.timescale - b.start.value / b.start.timescale);
  const left = videos[0],
    right = videos.find((c) => c.start.value / c.start.timescale === 2);
  assert(left && right);
  await page.selectOption('#selected', left.id);
  await page.selectOption('#dissolve-right', right.id);
  await page.locator('#dissolve-duration').fill('1/2');
  await click('Set cross-dissolve');
  await expect(page.locator('#status')).toContainText('Insufficient dissolve source handle');
  assert.deepEqual(await native(), initial);
  // Explicitly select a later source window while restoring the same placement.
  // Three-second fixtures provide the handles; audio remains an independent edit.
  await page.selectOption('#selected', right.id);
  await page.locator('#trim-start').fill('9/4');
  await page.locator('#trim-end').fill('3');
  await click('Trim selected clip');
  await click('Unlink selected group');
  await page.locator('#at').fill('-1/4');
  await click('Move linked clips');
  await page.locator('#trim-start').fill('2');
  await page.locator('#trim-end').fill('3');
  await click('Trim selected clip');
  await page.selectOption('#selected', left.id);
  await page.locator('#fade-in').fill('1/4');
  await page.locator('#fade-out').fill('0');
  await click('Set visual fades');
  const prepared = await native();
  const audio = prepared.sequence.clips.filter((c) => c.kind === 'audio');
  assert.deepEqual(
    audio,
    initial.sequence.clips.filter((c) => c.kind === 'audio'),
    'Source-handle preparation must not move independent audio',
  );
  await page.selectOption('#selected', left.id);
  await page.selectOption('#dissolve-right', right.id);
  await click('Set cross-dissolve');
  const transitioned = await native();
  assert(
    transitioned.sequence.transitions,
    'Dissolve apply failed: ' +
      (await page.locator('#status').textContent()) +
      ' native=' +
      JSON.stringify(transitioned.sequence.clips.filter((c) => c.kind === 'video')),
  );
  assert.equal(transitioned.sequence.transitions.length, 1);
  assert.deepEqual(
    transitioned.sequence.clips,
    prepared.sequence.clips,
    'Adding an edge must not change clip positions, audio or captions',
  );
  assert.deepEqual(transitioned.sequence.duration, prepared.sequence.duration);
  await click('Undo');
  assert.deepEqual(await native(), prepared);
  await click('Redo');
  assert.deepEqual(await native(), transitioned);
  await page.locator('#at').fill('19/10');
  await click('Split linked clips');
  await expect(page.locator('#status')).toContainText('Dissolve window exceeds clip');
  assert.deepEqual(await native(), transitioned);
  await click('Delete linked clips');
  assert.equal((await native()).sequence.transitions, undefined);
  await click('Undo');
  assert.deepEqual(await native(), transitioned);
  await page.locator('#preview-frame').fill('50');
  await click('Preview frame');
  await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 60000 });
  await click('Play');
  await expect(page.getByRole('button', { name: 'Stop media', exact: true })).toBeEnabled();
  await click('Stop media');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  assert.deepEqual(
    await page.evaluate(() =>
      globalThis[Symbol.for('editor-platform.private.decoded-frame-budget.v1')].snapshot(),
    ),
    { pixels: 0, bytes: 0 },
  );
  assert.equal(
    await page.evaluate(
      () => [...globalThis.document.fonts].filter((f) => f.family.startsWith('EPVideo-')).length,
    ),
    0,
  );
  await click('Play');
  await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 60000 });
  const imageLeft = transitioned.sequence.clips.find(
    (c) => c.kind === 'image' && c.start.value / c.start.timescale === 4.5,
  );
  const imageRight = transitioned.sequence.clips.find(
    (c) => c.kind === 'image' && c.start.value / c.start.timescale === 5,
  );
  assert(imageLeft && imageRight);
  await page.selectOption('#selected', imageLeft.id);
  await page.selectOption('#dissolve-right', imageRight.id);
  await click('Set cross-dissolve');
  assert.equal((await native()).sequence.transitions.length, 2);
  assert.deepEqual((await native()).sequence.clips, transitioned.sequence.clips);
  await page.locator('#preview-frame').fill('125');
  await click('Preview frame');
  await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 60000 });
  await click('Play');
  await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 60000 });
}
export function verifyDissolveOutput(directory, output) {
  const run = (args) =>
    execFileSync(
      'ffmpeg',
      ['-v', 'error', ...args, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
      { maxBuffer: 8 * 1024 ** 2 },
    );
  const actual = run(['-i', output, '-vf', 'select=eq(n\\,50)']);
  const expected = run([
    '-i',
    path.join(directory, 'one.mp4'),
    '-i',
    path.join(directory, 'two.mp4'),
    '-i',
    path.join(directory, 'quadrants.png'),
    '-filter_complex',
    '[0:v]select=eq(n\\,25),setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[a];[1:v]select=eq(n\\,6),setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[b];[a][b]blend=all_expr=0.5*A+0.5*B[mix];[2:v]scale=1080:1920:force_original_aspect_ratio=decrease[png];[mix][png]overlay=(W-w)/2:(H-h)/2:format=rgb',
  ]);
  assert.equal(actual.length, expected.length);
  let error = 0;
  for (let i = 0; i < actual.length; i++) error += Math.abs(actual[i] - expected[i]);
  const meanRgbError = error / actual.length;
  assert(meanRgbError < 5, `Independent cross-dissolve mismatch: ${meanRgbError}`);
  const actualImage = run(['-i', output, '-vf', 'select=eq(n\\,125)']);
  const originals = [
    ['quadrants.png', false],
    ['oriented.jpeg', true],
  ].map(([name, rotate]) =>
    run([
      '-noautorotate',
      '-i',
      path.join(directory, name),
      '-filter_complex',
      `color=c=black:s=1080x1920:r=25[bg];[0:v]${rotate ? 'transpose=clock,' : ''}scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=rgb`,
    ]),
  );
  let imageError = 0;
  for (let i = 0; i < actualImage.length; i++)
    imageError += Math.abs(actualImage[i] - (originals[0][i] + originals[1][i]) / 2);
  const imageMeanRgbError = imageError / actualImage.length;
  assert(
    imageMeanRgbError < 5,
    `Independent alpha/orientation dissolve mismatch: ${imageMeanRgbError}`,
  );
  return { frame: 50, weights: [0.5, 0.5], meanRgbError, imageFrame: 125, imageMeanRgbError };
}
