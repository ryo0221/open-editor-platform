import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { chromiumExecutablePath } from '../../tests/playwright/chromium';

it('real Video admission mounts, reports invalid native input at Host boundary and revokes fixed source', async () => {
  const built = await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'schema-host.ts',
      contents: `
      import {EditorSession, command} from '@editor-platform/editor-core';
      import {SchemaExperimentRegistry} from '@editor-platform/extension-runtime/schema-experiment';
      import {videoMetadataExtension} from '@editor-platform/video-metadata';
      const identity={kind:'literal',value:'video-core-prototype-v0'};
      const clock={now:()=>performance.now(),subscribe(fn){const timer=setInterval(fn,10);return()=>clearInterval(timer)}};
      const registry=new SchemaExperimentRegistry(clock,[{artifactKind:'video',schemaIdentity:identity}]);
      const definition=videoMetadataExtension('b'.repeat(64));
      const installed=registry.install(definition,{trust:'trusted',verifiedPin:definition.manifest});
      let allowed=true;const listeners=new Set();
      const content={schema:identity.value,sequence:{id:'native-video',duration:{value:4,timescale:1},frameRate:{value:30,timescale:1},tracks:[],clips:[]},sources:[]};
      const session=new EditorSession(content);
      const binding={artifactId:'metadata',artifactKind:'video',schemaIdentity:identity,session,allowedRead:()=>allowed,
        subscribeReadPermission(fn){listeners.add(fn);return()=>listeners.delete(fn)}};
      const container=document.querySelector('main');
      function open(binding){try{const result=installed.open(binding);if(result.state!=='opened')throw Error(result.code);result.handle.mount(container);return result.handle;}
        catch(error){document.querySelector('output').textContent='Host admission: '+error.message;return null;}}
      let handle=open(binding);
      globalThis.host={
        invalid(){handle.revoke();handle=open({...binding,session:new EditorSession({...content,schema:1})});},
        fresh(){handle=open(binding);},
        change(){session.execute(command('rename','Rename',c=>({...c,sequence:{...c.sequence,id:'changed-video'}})));try{handle.context.basic.read()}catch(error){document.querySelector('output').textContent=error.message}},
        deny(){allowed=false;for(const fn of [...listeners])fn();},
        async drain(){return await handle.drain({deadlineMs:performance.now()+1000});},
      };
    `,
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  });
  const browser = await chromium.launch({
    executablePath: chromiumExecutablePath(),
    args: ['--no-sandbox'],
  });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } }),
        errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('http://localhost/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<main></main><output></output>' }),
      );
      await page.goto('http://localhost/');
      await page.addScriptTag({ content: built.outputFiles[0].text });
      expect(await page.locator('output').textContent()).toBe('');
      expect(await page.locator('main').textContent()).toContain('native-video');
      await page.evaluate('host.invalid()');
      expect(await page.locator('main').textContent()).toBe('');
      expect(await page.locator('output').textContent()).toBe('Host admission: InvalidContent');
      await page.evaluate('host.fresh()');
      await page.evaluate('host.change()');
      expect(await page.locator('main').textContent()).toBe('');
      expect(await page.locator('output').textContent()).toBe('ScopeRevoked');
      await page.evaluate('host.fresh()');
      expect(await page.locator('main').textContent()).toContain('changed-video');
      await page.evaluate('host.deny()');
      expect(await page.locator('main').textContent()).toBe('');
      expect(await page.evaluate('host.drain()')).toMatchObject({ state: 'drained' });
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
