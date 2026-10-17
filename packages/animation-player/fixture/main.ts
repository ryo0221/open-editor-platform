import {
  SCHEMA,
  identityTransform,
  prepareAnimation,
  evaluateAnimation,
  type AnimationContent,
} from '@editor-platform/animation-core';
import { mountAnimationPreview } from '@editor-platform/animation-player/preview';
import { preparePreviewImage } from '@editor-platform/animation-player/resources';
const content: AnimationContent = {
  schemaVersion: SCHEMA,
  ticksPerSecond: 240000,
  rootCompositionId: 'root',
  assets: [],
  compositions: [
    {
      id: 'root',
      width: 320,
      height: 180,
      duration: 240000,
      frameRate: { numerator: 24, denominator: 1 },
      layers: [
        {
          id: 'group',
          type: 'group',
          parentId: null,
          start: 0,
          end: 240000,
          transform: { ...identityTransform(), x: 30, y: 30, opacity: 0.8 },
        },
        {
          id: 'box',
          type: 'rect',
          parentId: 'group',
          start: 0,
          end: 240000,
          transform: { ...identityTransform(), opacity: 0.5 },
          width: 60,
          height: 40,
          fill: '#2563eb',
        },
      ],
      tracks: [
        {
          id: 'move',
          layerId: 'box',
          property: 'x',
          keys: [
            { id: 'a', tick: 0, value: 0, easing: { type: 'linear' } },
            { id: 'b', tick: 240000, value: 200, easing: { type: 'hold' } },
          ],
        },
      ],
    },
  ],
};
content.compositions.push({
  id: 'child',
  width: 80,
  height: 80,
  duration: 120000,
  frameRate: { numerator: 30, denominator: 1 },
  tracks: [
    {
      id: 'child-jump',
      layerId: 'orange',
      property: 'x',
      keys: [
        { id: 'child-before', tick: 0, value: 0, easing: { type: 'hold' } },
        { id: 'child-endpoint', tick: 120000, value: 40, easing: { type: 'hold' } },
      ],
    },
  ],
  layers: [
    {
      id: 'orange',
      type: 'rect',
      parentId: null,
      start: 0,
      end: 120000,
      width: 30,
      height: 30,
      fill: '#f97316',
      transform: { ...identityTransform(), rotation: 30 },
    },
  ],
});
content.compositions[0].layers.push({
  id: 'nested',
  type: 'composition',
  parentId: null,
  start: 0,
  end: 240000,
  transform: { ...identityTransform(), x: 260, y: 120 },
  source: { type: 'local', compositionId: 'child' },
  time: { sourceIn: 0, sourceOut: 120000, rate: { numerator: 1, denominator: 1 }, after: 'hold' },
});
const original = JSON.stringify(content),
  prepared = await prepareAnimation(content);
let time = 0,
  id = 0;
const callbacks = new Map<number, () => void>();
const clock = {
  now: () => time,
  request: (cb: () => void) => {
    callbacks.set(++id, cb);
    return id;
  },
  cancel: (id: number) => {
    callbacks.delete(id);
  },
};
const abort = new AbortController();
const player = mountAnimationPreview(document.querySelector<HTMLElement>('#stage')!, {
  source: prepared,
  compositionId: 'root',
  label: 'Blue rectangle animation',
  signal: abort.signal,
  clock: new URLSearchParams(location.search).has('realtime') ? undefined : clock,
  autoPlay: new URLSearchParams(location.search).has('autoplay'),
});
if (new URLSearchParams(location.search).has('endpoint')) {
  player.seek(240000);
  const section = document.createElement('section');
  const caption = document.createElement('p');
  caption.textContent =
    'Above: parent final preview holds child tick 119999 (x=0). Below: direct child terminal preview at tick 120000 shows the hold jump (x=40).';
  const stage = document.createElement('div');
  stage.id = 'child-endpoint';
  stage.style.cssText = 'width:160px;height:160px;background:#f1f5f9';
  section.append(caption, stage);
  document.body.append(section);
  const child = mountAnimationPreview(stage, {
    source: prepared,
    compositionId: 'child',
    label: 'Child exact terminal pose',
    signal: abort.signal,
    clock,
  });
  child.seek(120000);
}
document.querySelector<HTMLButtonElement>('#play')!.onclick = () => player.play();
document.querySelector<HTMLButtonElement>('#pause')!.onclick = () => player.pause();
document.querySelector<HTMLButtonElement>('#close')!.onclick = () => {
  abort.abort();
  document.querySelector('#status')!.textContent = 'Closed';
  for (const element of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
    'button, input',
  ))
    element.disabled = true;
};
document.querySelector<HTMLInputElement>('#tick')!.oninput = (e) =>
  player.seek(Number((e.target as HTMLInputElement).value));
const fixture = {
  player,
  advance(ms: number) {
    time = ms;
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((cb) => cb());
  },
  pending: () => callbacks.size,
  unchanged: () => JSON.stringify(content) === original,
  sceneAt: (tick: number) => evaluateAnimation(prepared, 'root', tick),
  childSceneAt: (tick: number) => evaluateAnimation(prepared, 'child', tick),
  preparePreviewImage,
};
declare global {
  interface Window {
    animationPreview: typeof fixture;
  }
}
window.animationPreview = fixture;
document.querySelector('#status')!.textContent = 'Ready';
