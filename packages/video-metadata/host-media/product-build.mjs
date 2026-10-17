import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
/** Local build only, fixed external candidates; never rewrites dependencies. */
export async function productBuild(
  deps,
  { entryPoint, transformAacForTest, metafile = false, banner, define } = {},
) {
  // Private per-track lifecycle hook is supported only for these exact sources.
  for (const [file, expected] of [
    ['media-source.js', '1c60a60034eff049d8ee1a973de7ef665bb8e648ee14854227150556e25f9088'],
    ['output.js', '699dae1192ee789c32577a0cf2e9980d41845af4e66b8ba626e6ba87f9b511b3'],
  ]) {
    const source = await readFile(
      path.join(deps, 'node_modules/mediabunny/dist/modules/src', file),
    );
    if (createHash('sha256').update(source).digest('hex') !== expected)
      throw Error('Pinned track lifecycle source drift');
  }
  const state = path.resolve('packages/video-metadata/host-media/encoder-state.mjs');
  return build({
    entryPoints: [entryPoint ?? 'packages/video-metadata/host-media/product-entry.ts'],
    nodePaths: [path.join(deps, 'node_modules')],
    bundle: true,
    write: false,
    metafile,
    ...(banner ? { banner } : {}),
    ...(define ? { define } : {}),
    platform: 'browser',
    format: 'iife',
    plugins: [
      {
        name: 'fixed-aac-timing',
        setup(b) {
          b.onLoad({ filter: /mediabunny-aac-encoder\.mjs$/ }, async ({ path }) => {
            let contents = await readFile(path, 'utf8');
            if (
              createHash('sha256').update(contents).digest('hex') !==
              'a8f777ab53d8d654bd2339e974de8c80f457e68943afd72e7e55ca0f0dbea214'
            )
              throw Error('AAC candidate identity');
            for (const [from, to] of [
              [
                '  async init() {',
                '  async init() {\n    this.videoHostOwner = encodingState();\n    this.videoHostOwner.encoders.add(this);',
              ],
              [
                '  close() {\n    this.worker?.terminate();\n  }',
                '  close() {\n    if (this.videoHostClosed) return;\n    this.videoHostClosed = true;\n    this.workerError = new Error("AAC worker terminated");\n    for (const pending of this.pendingMessages.values()) pending.reject(this.workerError);\n    this.pendingMessages.clear();\n    this.worker?.terminate();\n    this.worker = null;\n    this.videoHostOwner?.encoders.delete(this);\n  }',
              ],
              [
                '    this.worker = await Worker2();',
                '    this.worker = await Worker2();\n    if (this.videoHostClosed) { this.worker.terminate(); this.worker = null; throw this.workerError; }',
              ],
              [
                '    const onMessage = (data) => {',
                '    const onMessage = (data) => {\n      if (this.videoHostClosed) return;',
              ],
              [
                '    this.ctx = result.ctx;',
                '    if (this.videoHostClosed) throw this.workerError;\n    this.ctx = result.ctx;',
              ],
              [
                'this.nextPacketTimestampInSamples / this.sampleRate,',
                'Number(p.pts) / this.sampleRate,',
              ],
              [
                'p.duration / this.sampleRate',
                'Math.min(p.duration,encodingState().validEnd-Number(p.pts)) / this.sampleRate',
              ],
              [
                'const packet = new EncodedPacket(',
                'encodingState().rawPackets.push({pts:Number(p.pts),duration:p.duration}); const packet = new EncodedPacket(',
              ],
            ]) {
              if (contents.split(from).length !== 2) throw Error('AAC patch shape');
              contents = contents.replace(from, to);
            }
            if (transformAacForTest) contents = transformAacForTest(contents);
            return {
              contents: `import {encodingState} from ${JSON.stringify(state)};\n` + contents,
              loader: 'js',
            };
          });
        },
      },
    ],
  });
}
