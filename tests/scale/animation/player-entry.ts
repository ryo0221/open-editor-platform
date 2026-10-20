/** Browser entry for player-frame.mjs. */
import {
  createAnimation2,
  createAnimationLayer2,
  encodeAnimationBase64,
  hashAnimationBytes2,
  prepareAnimation2,
  type Layer2,
} from '@editor-platform/animation-core/v2';
import { mountAnimationPlayer2 } from '@editor-platform/animation-player/v2';
declare const PNG: number[];
(window as unknown as { bench: unknown }).bench = async (
  layers: number,
  images: number,
  animated: number,
) => {
  const content = createAnimation2(),
    c = content.compositions[0];
  for (let i = 0; i < images; i++) {
    const bytes = new Uint8Array(1536 * 1024);
    bytes.set(PNG);
    bytes[bytes.length - 1] = i;
    content.assets.push({
      id: `p${i}`,
      contentHash: hashAnimationBytes2(bytes),
      mediaType: 'image/png',
      base64: encodeAnimationBase64(bytes),
      attribution: 'F',
      license: 'N',
    });
    c.layers.push({
      ...createAnimationLayer2('group', `img${i}`, c.duration),
      type: 'image',
      width: 100,
      height: 100,
      assetId: `p${i}`,
    } as Layer2);
  }
  for (let i = 0; i < layers; i++)
    c.layers.push(createAnimationLayer2('rect', `l${i}`, c.duration));
  c.tracks = c.layers.slice(0, animated).map((l, i) => ({
    id: `t${i}`,
    layerId: l.id,
    property: 'x' as const,
    keys: [
      { id: `k${i}a`, tick: 0, value: 0, easing: { type: 'linear' as const } },
      { id: `k${i}b`, tick: c.duration, value: 300, easing: { type: 'hold' as const } },
    ],
  }));
  const source = prepareAnimation2(content);
  const host = document.createElement('div');
  host.style.cssText = 'width:640px;height:360px';
  document.body.append(host);
  const player = await mountAnimationPlayer2(host, {
    source,
    compositionId: c.id,
    label: 'bench',
    clock: { now: () => 0, request: () => 0, cancel: () => {} },
  });
  const times: number[] = [];
  for (let f = 1; f <= 200; f++) {
    const t = performance.now();
    player.seek((f * 4000) % 960000);
    host.getBoundingClientRect();
    times.push(performance.now() - t);
  }
  // force style/layout of the final frame so DOM work is not deferred out of the measurement
  host.getBoundingClientRect();
  const sorted = times.slice(5).sort((a, b) => a - b);
  const nodes = host.querySelectorAll('*').length;
  player.dispose();
  host.remove();
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    nodes,
  };
};
