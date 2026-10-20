/**
 * Animation schema 2 edit benchmark: one shared `layer.patch` per iteration through
 * prepareEditorCommand (client) and Authority.commit (server). Reports the median of
 * five warm iterations and counts SHA-256 calls/bytes. Not part of `npm test`:
 *   npx vitest run --config tests/scale/animation/vitest.config.ts
 */
import { readFileSync } from 'node:fs';
import { it, vi } from 'vitest';
const counts = vi.hoisted(() => ({ sha: 0, shaBytes: 0 }));
vi.mock('@noble/hashes/sha256', async (original) => {
  const m = await original<typeof import('@noble/hashes/sha256')>();
  const sha256 = Object.assign((data: Parameters<typeof m.sha256>[0]) => {
    counts.sha++;
    counts.shaBytes += data.length;
    return m.sha256(data);
  }, m.sha256);
  return { ...m, sha256 };
});
import { Authority, initial, type Principal } from '@editor-platform/collaboration-core';
import { reuseHash } from '@editor-platform/reuse-core';
import { deepFreeze } from '@editor-platform/artifact-core';
import {
  createAnimation2,
  createAnimationLayer2,
  animationCommand2,
  encodeAnimationBase64,
  hashAnimationBytes2,
  createPlayableAnimationEmbed,
  insertExactAnimation,
  type AnimationContent2,
  type AnimationEmbed2,
  type Layer2,
} from '@editor-platform/animation-core/v2';
import {
  animationEditorCodec as codec,
  prepareEditorCommand,
} from '@editor-platform/collaboration-adapters';
const A: Principal = { actorId: 'A', clientId: 'A', sessionId: 'A', writable: true, scopes: ['*'] };
function image(i: number) {
  const bytes = new Uint8Array(1536 * 1024);
  bytes.set(readFileSync('tests/fixtures/office/images/quadrants.png'));
  bytes[bytes.length - 1] = i;
  return {
    id: `picture-${i}`,
    contentHash: hashAnimationBytes2(bytes),
    mediaType: 'image/png' as const,
    base64: encodeAnimationBase64(bytes),
    attribution: 'F',
    license: 'N',
  };
}
function doc(layers: number, withAssets: boolean): AnimationContent2 {
  let content = createAnimation2();
  const c = content.compositions[0];
  for (let i = 0; i < layers; i++)
    c.layers.push(createAnimationLayer2('rect', `l${i}`, c.duration));
  c.tracks = c.layers.slice(0, Math.min(layers, 200)).map((l, i) => ({
    id: `t${i}`,
    layerId: l.id,
    property: 'x' as const,
    keys: [
      { id: `k${i}a`, tick: 0, value: 0, easing: { type: 'linear' as const } },
      { id: `k${i}b`, tick: 960000, value: 10, easing: { type: 'hold' as const } },
    ],
  }));
  if (withAssets) {
    content.assets = [image(1)];
    c.layers.push({
      ...createAnimationLayer2('group', 'img', c.duration),
      type: 'image',
      width: 10,
      height: 10,
      assetId: 'picture-1',
    } as Layer2);
    const child = createAnimation2();
    child.assets = [image(2)];
    child.compositions[0].layers = [
      {
        ...createAnimationLayer2('group', 'cimg', 960000),
        type: 'image',
        width: 10,
        height: 10,
        assetId: 'picture-2',
      } as Layer2,
    ];
    const embed = createPlayableAnimationEmbed(
      { artifactId: 'B', versionId: 'v1', compositionId: 'root', contentHash: reuseHash(child) },
      child,
      'B',
    );
    content = insertExactAnimation(content, 'root', embed as AnimationEmbed2, 'nested', {
      canEdit: () => true,
    }).apply(content);
  }
  return content;
}
for (const [name, layers, assets] of [
  ['1000 layers, no assets', 1000, false],
  ['20 layers + 2x1.5MB image (1 in exact source)', 20, true],
  ['998 layers + assets', 998, true],
] as const) {
  it(
    name,
    () => {
      const authority = new Authority(codec, initial('animation', codec, doc(layers, assets)));
      const rows: number[][] = [];
      for (let i = 0; i < 6; i++) {
        const base = authority.snapshot();
        deepFreeze(base.content); // client sessions hold immutable snapshots
        counts.sha = 0;
        counts.shaBytes = 0;
        const t0 = performance.now();
        const op = prepareEditorCommand(
          codec,
          base,
          A,
          animationCommand2(
            base.content,
            [
              {
                type: 'layer.patch',
                compositionId: 'root',
                id: 'l5',
                patch: { transform: { x: i + 1 } },
              },
            ],
            { canEdit: () => true },
          ),
        )!;
        const t1 = performance.now();
        const prepSha = counts.sha,
          prepBytes = counts.shaBytes;
        const r = authority.commit(A, op);
        if (r.status !== 'accepted') throw Error(JSON.stringify(r));
        const t2 = performance.now();
        rows.push([
          t1 - t0,
          t2 - t1,
          prepSha,
          prepBytes / 1e6,
          counts.sha - prepSha,
          (counts.shaBytes - prepBytes) / 1e6,
        ]);
      }
      const med = (k: number) =>
        rows
          .map((r) => r[k])
          .slice(1)
          .sort((a, b) => a - b)[2];
      console.log(
        `BENCH ${name}: prepare ${med(0).toFixed(1)}ms, commit ${med(1).toFixed(1)}ms, sha calls prepare=${med(2)} (${med(3).toFixed(1)}MB) commit=${med(4)} (${med(5).toFixed(1)}MB)`,
      );
    },
    600000,
  );
}
