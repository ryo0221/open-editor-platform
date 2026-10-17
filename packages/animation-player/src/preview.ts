import {
  evaluateAnimation,
  inspectPreparedComposition,
  type PreparedAnimation,
} from '@editor-platform/animation-core';
import { createPreviewTransport, type PreviewClock } from './transport';
export const PLAYER_VERSION = 'animation-svg-player-prototype-0';
export interface PreviewOptions {
  source: PreparedAnimation;
  compositionId: string;
  label: string;
  signal?: AbortSignal;
  clock?: PreviewClock;
  loop?: boolean;
  autoPlay?: boolean;
}
/** Reversible trusted preview only: rect/group/nested SVG, no scripts or network. */
export function mountAnimationPreview(container: HTMLElement, options: PreviewOptions) {
  const { source, compositionId, signal } = options;
  if (signal?.aborted) throw new Error('Player aborted');
  const metadata = inspectPreparedComposition(source, compositionId);
  if (metadata.hasAssets) throw new Error('Asset-backed scenes unsupported by rectangle preview');
  const doc = container.ownerDocument,
    win = doc.defaultView;
  if (!win) throw new Error('Missing document window');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', options.label);
  svg.setAttribute('viewBox', `0 0 ${metadata.width} ${metadata.height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const group = doc.createElementNS(ns, 'g');
  svg.append(group);
  let disposed = false;
  const draw = (tick: number) => {
    if (disposed) throw new Error('Player disposed');
    const scene = evaluateAnimation(source, compositionId, tick);
    const fragment = doc.createDocumentFragment();
    for (const item of scene.rectangles) {
      const rect = doc.createElementNS(ns, 'rect');
      rect.setAttribute('width', String(item.width));
      rect.setAttribute('height', String(item.height));
      rect.setAttribute('fill', item.fill);
      rect.setAttribute('opacity', String(item.opacity));
      rect.setAttribute('transform', `matrix(${item.matrix.join(' ')})`);
      rect.setAttribute('data-instance', JSON.stringify(item.instancePath));
      fragment.append(rect);
    }
    group.replaceChildren(fragment);
    svg.dataset.tick = String(tick);
  };
  const clock = options.clock ?? {
    now: () => win.performance.now(),
    request: (cb: () => void) => win.requestAnimationFrame(cb),
    cancel: (id: number) => win.cancelAnimationFrame(id),
  };
  const transport = createPreviewTransport(
    metadata.duration,
    metadata.ticksPerSecond,
    clock,
    draw,
    options.loop,
  );
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
  const stopWhenHidden = () => {
    if (doc.hidden && !disposed) transport.pause();
  };
  const stopReducedMotion = () => {
    if (reduced.matches && !disposed) transport.pause();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    transport.dispose();
    doc.removeEventListener('visibilitychange', stopWhenHidden);
    reduced.removeEventListener('change', stopReducedMotion);
    signal?.removeEventListener('abort', dispose);
    svg.remove();
  };
  try {
    draw(0);
    container.append(svg);
    doc.addEventListener('visibilitychange', stopWhenHidden);
    reduced.addEventListener('change', stopReducedMotion);
    signal?.addEventListener('abort', dispose, { once: true });
    if (signal?.aborted) {
      dispose();
      throw new Error('Player aborted');
    }
    if (options.autoPlay && !doc.hidden && !reduced.matches) transport.play();
  } catch (error) {
    dispose();
    throw error;
  }
  return Object.freeze({
    get tick() {
      return transport.tick;
    },
    get playing() {
      return transport.playing;
    },
    seek: (tick: number) => transport.seek(tick),
    play: () => {
      if (doc.hidden) throw new Error('Player hidden');
      transport.play();
    },
    pause: () => transport.pause(),
    setRate: (rate: number) => transport.setRate(rate),
    dispose,
  });
}
