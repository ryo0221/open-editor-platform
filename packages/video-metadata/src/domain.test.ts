import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser } from '@playwright/test';
import { videoMetadataExtension } from './index';
import { time, type VideoContent } from '@editor-platform/video-core';

const fixture: VideoContent = {
  schema: 'video-core-prototype-v0',
  sequence: {
    id: 'sequence',
    duration: time(4),
    frameRate: time(30000, 1001),
    tracks: [
      { id: 'visual', kind: 'visual', enabled: true, locked: false },
      { id: 'audio', kind: 'audio', enabled: false, locked: true },
    ],
    clips: [
      {
        id: 'v',
        kind: 'video',
        trackId: 'visual',
        sourceId: 'source',
        streamId: 'vs',
        start: time(1),
        duration: time(2),
        sourceIn: time(-1),
        sourceOut: time(1),
        rate: time(1),
        linkGroupId: 'av',
      },
      {
        id: 'a',
        kind: 'audio',
        trackId: 'audio',
        sourceId: 'source',
        streamId: 'as',
        start: time(1),
        duration: time(2),
        sampleIn: 48000,
        sampleOut: 144000,
        linkGroupId: 'av',
      },
    ],
  },
  sources: [
    {
      id: 'source',
      asset: { assetId: 'media', sha256: 'a'.repeat(64), byteLength: 1024 },
      streams: [
        {
          id: 'vs',
          kind: 'video',
          timebase: time(1, 90000),
          startPts: -180000,
          endPts: 900000,
          presentationOrigin: time(0),
        },
        {
          id: 'as',
          kind: 'audio',
          sampleRate: 48000,
          sampleCount: 192000,
          presentationOrigin: time(-1),
        },
      ],
    },
  ],
};
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const result = await build({
    entryPoints: ['packages/video-metadata/src/index.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'VideoMetadata',
    platform: 'browser',
    minify: true,
  });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
});
afterAll(async () => {
  await browser?.close();
});
it('declares only the exact schema read/lifecycle contract and uses the real validator', () => {
  const definition = videoMetadataExtension('b'.repeat(64));
  expect(definition.manifest.contractVersion).toBe('1.0.0-experiment.schema.1');
  expect(definition.manifest.permissions).toEqual(['artifact:read']);
  expect(Object.keys(definition.manifest.addons)).toEqual(['lifecycle']);
  expect(definition.schemaOf(fixture)).toEqual({ kind: 'literal', value: fixture.schema });
  expect(definition.validate(fixture)).toBe(true);
  expect(definition.validate({ ...fixture, schema: 1 })).toBe(false);
  expect(definition.validate({ ...fixture, extra: true })).toBe(false);
  expect(() => videoMetadataExtension('invalid')).toThrow();
});
for (const width of [1280, 390]) {
  it.each([
    'valid',
    'invalid',
    'aborted',
    'read-revoke',
    'register-dispose',
    'mismatch',
    'snapshot-mismatch',
    'dispose',
    'replacement',
    'late-mount',
  ])('%s browser lifecycle and native projection at ' + width, async (mode) => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    try {
      await page.setContent('<main><span id="host">Host sibling</span></main>');
      await page.addScriptTag({ content: bundle });
      // Actual public domain implementation runs in Chromium; only Host ports are supplied here.
      const result = await page.evaluate(`(() => {
        const mode = ${JSON.stringify(mode)};
        const content = ${JSON.stringify(fixture)};
        if (mode === 'invalid') { content.extra = true; content.sequence.duration.value = -1; }
        const before = JSON.stringify(content);
        const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
        freeze(content);
        const controller = new AbortController();
        const scope = { artifactId: 'video', sessionId: 'session', generation: 'one' };
        const disposers = []; let reads = 0;
        const lifecycle = {
          version: 'lifecycle@0-draft', scope, signal: controller.signal,
          assertCurrent() { if (controller.signal.aborted) throw new Error('revoked'); },
          registerDisposable(id, dispose) { disposers.push(dispose); if (mode === 'register-dispose') dispose(); }
        };
        const context = {
          basic: { scope, read() { reads++; if (mode === 'read-revoke') controller.abort(); return { scope: mode === 'snapshot-mismatch' ? {...scope, generation:'wrong'} : scope, revision: {}, content }; } },
          lifecycle
        };
        if (mode === 'mismatch') context.basic.scope = {...scope, generation:'wrong'};
        if (mode === 'aborted') controller.abort();
        const definition = VideoMetadata.videoMetadataExtension('b'.repeat(64));
        const container = document.querySelector('main'); let rejected = false;
        try { definition.mount(container, context); } catch { rejected = true; }
        const text = container.textContent;
        if (mode === 'dispose') { disposers[0](); disposers[0](); controller.abort(); }
        if (mode === 'replacement') {
          const fresh = new AbortController();
          const freshScope = {...scope, generation: 'two'};
          definition.mount(container, {basic:{scope:freshScope, read:()=>({scope:freshScope,revision:{},content})}, lifecycle:{...lifecycle,scope:freshScope,signal:fresh.signal, assertCurrent(){if(fresh.signal.aborted) throw Error('revoked');},registerDisposable(){}}});
          controller.abort(); disposers[0]();
        }
        if (mode === 'late-mount') { controller.abort(); try { definition.mount(container, context); } catch { rejected = true; } }
        return {text, rejected, reads, count:container.querySelectorAll('section').length, sibling:!!document.querySelector('#host'), unchanged:before===JSON.stringify(content), controls:container.querySelectorAll('button,input,video,audio,canvas').length};
      })()`);
      const value = result as {
        text: string;
        rejected: boolean;
        reads: number;
        count: number;
        sibling: boolean;
        unchanged: boolean;
        controls: number;
      };
      expect(value.sibling).toBe(true);
      expect(value.unchanged).toBe(true);
      expect(value.controls).toBe(0);
      if (
        [
          'aborted',
          'read-revoke',
          'register-dispose',
          'mismatch',
          'snapshot-mismatch',
          'late-mount',
        ].includes(mode)
      ) {
        expect(value.rejected).toBe(true);
        expect(value.count).toBe(0);
      } else {
        expect(value.rejected).toBe(false);
        expect(value.count).toBe(mode === 'dispose' ? 0 : 1);
      }
      if (mode === 'valid') {
        for (const text of [
          '30000/1001 fps',
          '2 tracks; 2 clips; 1 sources',
          '[1/1 s, 3/1 s)',
          'enabled=false; locked=true',
          'Source samples [48000, 144000)',
          'PTS [-180000, 900000)',
          'presentation origin=-1/1 s',
          'not probed',
        ])
          expect(value.text).toContain(text);
      }
      if (mode === 'invalid') {
        expect(value.text).toContain('First validation failure');
        expect(value.text).toContain('Unknown or missing field');
        expect(value.text).not.toContain('Timeline');
      }
      if (['aborted', 'register-dispose', 'mismatch'].includes(mode)) expect(value.reads).toBe(0);
      if (mode === 'valid') {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({ path: `/tmp/video-metadata-${width}.png`, fullPage: true });
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
}
