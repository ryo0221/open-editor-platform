import {
  SCHEMA,
  identityTransform,
  prepareAnimation,
  prepareRectangleAnimationV1,
  evaluateAnimation,
  migratePrototypeDraftToV1,
  type PrototypeAnimationContent,
  type PreparedAnimation,
} from '@editor-platform/animation-core';
import {
  mountRectanglePlayerV1,
  RECTANGLE_PLAYER_CONTRACT_V1,
  type RectanglePlayerV1,
} from '@editor-platform/animation-player/v1';
const prototype: PrototypeAnimationContent = {
  schemaVersion: SCHEMA,
  ticksPerSecond: 48000,
  rootCompositionId: 'root',
  assets: [],
  compositions: [
    {
      id: 'root',
      width: 320,
      height: 180,
      duration: 48000,
      frameRate: { numerator: 24, denominator: 1 },
      layers: [
        {
          id: 'box',
          type: 'rect',
          parentId: null,
          start: 0,
          end: 48000,
          width: 60,
          height: 40,
          fill: '#2563eb',
          transform: { ...identityTransform(), y: 30, opacity: 0.5 },
        },
      ],
      tracks: [
        {
          id: 'x',
          layerId: 'box',
          property: 'x',
          keys: [
            { id: 'start', tick: 0, value: 10, easing: { type: 'linear' } },
            { id: 'end', tick: 48000, value: 210, easing: { type: 'hold' } },
          ],
        },
      ],
    },
  ],
};
const oldBytes = JSON.stringify(prototype);
const retained = await prepareAnimation(prototype),
  oldHash = retained.contentHash,
  abort = new AbortController();
let player: RectanglePlayerV1 | undefined, source: PreparedAnimation | undefined;
const stage = document.querySelector<HTMLElement>('#stage')!;
const migrate = document.querySelector<HTMLButtonElement>('#migrate')!;
migrate.onclick = async () => {
  const proposal = await migratePrototypeDraftToV1(
    { content: prototype, baseVersionId: 'old-version', updatedAt: '2026-10-12T00:00:00.000Z' },
    oldHash,
    '2026-10-12T06:00:00.000Z',
  );
  source = await prepareRectangleAnimationV1(proposal.draft.content);
  player = mountRectanglePlayerV1(stage, {
    source,
    compositionId: 'root',
    label: 'Rectangle v1 preview',
    signal: abort.signal,
  });
  migrate.disabled = true;
  document.querySelector<HTMLInputElement>('#tick')!.disabled = false;
  document.querySelector<HTMLButtonElement>('#close')!.disabled = false;
  document.querySelector('#status')!.textContent = 'v1 ready';
};
document.querySelector<HTMLInputElement>('#tick')!.oninput = (e) =>
  player!.seek(Number((e.target as HTMLInputElement).value));
document.querySelector<HTMLButtonElement>('#close')!.onclick = () => {
  abort.abort();
  document.querySelector<HTMLInputElement>('#tick')!.disabled = true;
  document.querySelector<HTMLButtonElement>('#close')!.disabled = true;
  document.querySelector('#status')!.textContent = 'Closed';
};
const fixture = {
  contract: RECTANGLE_PLAYER_CONTRACT_V1,
  oldHash,
  unchanged: () => JSON.stringify(prototype) === oldBytes,
  source: () => source,
  sceneAt: (tick: number) => evaluateAnimation(source!, 'root', tick),
  seek: (tick: number) => player!.seek(tick),
  dispose: () => player!.dispose(),
  rejectPrototype() {
    try {
      mountRectanglePlayerV1(stage, {
        source: retained,
        compositionId: 'root',
        label: 'Unsupported',
      });
      return false;
    } catch {
      return true;
    }
  },
};
declare global {
  interface Window {
    animationV1: typeof fixture;
  }
}
window.animationV1 = fixture;
