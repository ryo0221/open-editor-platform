import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { expect } from '@playwright/test';
export async function exerciseTitleScenario(page) {
  const click = (name) => page.getByRole('button', { name, exact: true }).click();
  const native = async () => JSON.parse(await page.locator('#native').textContent());
  await click('Load fixed Japanese regular font');
  await expect(page.locator('#status')).toHaveText('Load fixed font complete', { timeout: 60000 });
  await click('Add visual track');
  const track = await page.locator('#visual-track').inputValue();
  await page.selectOption('#title-track', track);
  await page.locator('#title-start').fill('0');
  await page.locator('#title-end').fill('1');
  await page.locator('#title-text').dispatchEvent('compositionstart');
  await page.locator('#title-text').fill('日本語タイトル\n字幕を保存');
  const before = await native();
  await page.locator('#preview-frame').fill('12');
  await click('Preview frame');
  await expect(page.locator('#status')).toContainText(/InputComposing|PendingInputs|composition/i);
  assert.deepEqual(await native(), before, 'Composition must not partially commit');
  await page.locator('#title-text').dispatchEvent('compositionend');
  await click('Preview frame');
  await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 60000 });
  const inserted = await native(),
    title = inserted.sequence.clips.find((c) => c.kind === 'title');
  assert(title);
  assert.equal(title.text, '日本語タイトル\n字幕を保存');
  assert.equal(
    await page.evaluate(
      () => [...globalThis.document.fonts].filter((f) => f.family.startsWith('EPVideo-')).length,
    ),
    0,
    'Transient preview font faces must be released',
  );
  await click('Undo');
  assert.deepEqual(await native(), before);
  await click('Redo');
  assert.deepEqual(await native(), inserted);
  await page.selectOption('#selected', title.id);
  await click('Edit selected title');
  await page.locator('#title-text').fill('未知\u{10ffff}');
  await click('Apply title');
  await expect(page.locator('#status')).toContainText('missing glyph');
  assert.deepEqual(await native(), inserted);
  await page.locator('#title-text').fill('日本語タイトル\nオフライン保存');
  // Save must flush the pending title, not serialize the previous text.
  const download = page.waitForEvent('download', { timeout: 60000 });
  await click('Save portable project');
  await download;
  await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.');
  assert.equal(
    (await native()).sequence.clips.find((c) => c.id === title.id).text,
    '日本語タイトル\nオフライン保存',
  );
  // Leave a real unsaved edit for the enclosing navigation-guard regression.
  await page.locator('#title-text').fill('日本語タイトル\n保存後の編集');
  await click('Apply title');
  await page.locator('#preview-frame').fill('12');
  await click('Preview frame');
  await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 60000 });
}
export function verifyTitleOutput(file) {
  const lit = (frame) => {
    const bytes = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        file,
        '-vf',
        `select=eq(n\\,${frame}),crop=972:288:54:1536`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { maxBuffer: 2 * 1024 ** 2 },
    );
    assert.equal(bytes.length, 972 * 288 * 3);
    let white = 0;
    for (let i = 0; i < bytes.length; i += 3)
      if (bytes[i] > 180 && bytes[i + 1] > 180 && bytes[i + 2] > 180) white++;
    return white;
  };
  const inside = lit(12),
    outside = lit(37);
  assert(inside > 500, 'Japanese title must be present in independently decoded output');
  assert.equal(outside, 0, 'Title must end at its native half-open interval');
  const captionInside = lit(82),
    captionOutside = lit(101);
  assert(captionInside > 500, 'Japanese captions must be burned into output');
  assert.equal(captionOutside, 0, 'Captions end at their declared time');
  return { inside, outside, captionInside, captionOutside };
}

export async function exerciseCaptionScenario(page) {
  const click = (name) => page.getByRole('button', { name, exact: true }).click();
  const native = async () => JSON.parse(await page.locator('#native').textContent());
  const before = await native();
  const srt =
    '1\n00:00:03,000 --> 00:00:03,400\n日本語字幕\n二行目\n\n2\n00:00:03,600 --> 00:00:04,000\n後半の字幕\n';
  await page.locator('#caption-file').setInputFiles({
    name: 'unsupported.vtt',
    mimeType: 'text/vtt',
    buffer: Buffer.from('WEBVTT\n\n00:03.000 --> 00:04.000 align:start\n字幕'),
  });
  await click('Import captions');
  await expect(page.locator('#status')).toContainText('Unsupported caption cue/settings');
  assert.deepEqual(await native(), before);
  await page
    .locator('#caption-file')
    .setInputFiles({ name: 'captions.srt', mimeType: 'text/plain', buffer: Buffer.from(srt) });
  await click('Import captions');
  await expect(page.locator('#title-status')).toHaveText('Imported 2 captions atomically.');
  const imported = await native();
  const captions = imported.sequence.clips.filter((c) => c.kind === 'caption');
  assert.equal(captions.length, 2);
  await click('Undo');
  assert.deepEqual(await native(), before);
  await click('Redo');
  assert.deepEqual(await native(), imported);
  await page.selectOption('#selected', captions[0].id);
  await page.locator('#at').fill('16/5');
  await click('Split linked clips');
  assert.equal((await native()).sequence.clips.filter((c) => c.kind === 'caption').length, 3);
  await click('Undo');
  assert.deepEqual(await native(), imported);
  await page.selectOption('#selected', captions[0].id);
  const animation = imported.sequence.clips.find((c) => c.kind === 'animation');
  await page.locator('#caption-link-target').fill(animation.id);
  await click('Link selected text explicitly');
  const linked = await native();
  assert.equal(
    linked.sequence.clips.find((c) => c.id === animation.id).linkGroupId,
    linked.sequence.clips.find((c) => c.id === captions[0].id).linkGroupId,
  );
  await page.locator('#at').fill('1/10');
  await click('Move linked clips');
  await expect(page.locator('#status')).toContainText('Overlapping visual clips');
  assert.deepEqual(
    await native(),
    linked,
    'A linked move must refuse atomically when Animation overlaps the next video',
  );
  await click('Undo');
  assert.deepEqual(await native(), imported);
  await page.selectOption('#selected', captions[0].id);
  await page.locator('#caption-link-target').fill(captions[1].id);
  await click('Link selected text explicitly');
  const captionLinked = await native();
  await click('Edit selected title');
  await page.locator('#title-start').fill('31/10');
  await page.locator('#title-end').fill('7/2');
  await click('Apply title');
  await expect(page.locator('#status')).toContainText('Linked text timing');
  assert.deepEqual(await native(), captionLinked);
  await click('Discard title edits');
  await click('Move linked clips');
  assert.notDeepEqual(await native(), captionLinked);
  await click('Undo');
  assert.deepEqual(await native(), captionLinked);
  await click('Undo');
  assert.deepEqual(await native(), imported);
  let webvtt;
  for (const format of ['SRT', 'VTT']) {
    const download = page.waitForEvent('download');
    await click('Export captions ' + format);
    const file = await download;
    const value = await readFile(await file.path(), 'utf8');
    if (format === 'SRT') assert.equal(value, srt);
    else {
      webvtt = value;
      assert.equal(
        value,
        'WEBVTT\n\n00:00:03.000 --> 00:00:03.400\n日本語字幕\n二行目\n\n00:00:03.600 --> 00:00:04.000\n後半の字幕\n',
      );
    }
  }
  await click('Undo');
  assert.deepEqual(await native(), before);
  await page
    .locator('#caption-file')
    .setInputFiles({ name: 'roundtrip.vtt', mimeType: 'text/vtt', buffer: Buffer.from(webvtt) });
  await click('Import captions');
  await expect(page.locator('#title-status')).toHaveText('Imported 2 captions atomically.');
  const cueValues = (items) =>
    items.map(({ start, duration, text }) => ({ start, duration, text }));
  assert.deepEqual(
    cueValues((await native()).sequence.clips.filter((c) => c.kind === 'caption')),
    cueValues(captions),
  );
  await page.locator('#preview-frame').fill('82');
  await click('Preview frame');
  await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 60000 });
  await click('Play');
  await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 60000 });
}
