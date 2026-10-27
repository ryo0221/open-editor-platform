import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  evaluateAnimation2,
  animationSvgAttribute2 as attr,
  animationSvgPathData2 as pathData,
  animationSvgTextData2,
  prepareAnimation2,
  animationPlaybackContent2,
  inspectPlayableAnimationEmbed,
  preparedAnimationContent2,
  inspectAnimationAsset2,
  animationCompositionAssets2,
  validateAnimationInputs2,
  type AnimationInputValues2,
  type PreparedAnimation2,
  type Scene2,
  type PlayableAnimationEmbed,
  type SceneClip2,
  type Asset2,
} from '@editor-platform/animation-core/v2';
import { createPreviewTransport, type PreviewClock } from './transport';
import { animationPngNotices } from './png-notices';
export const ANIMATION_PLAYER2 = 'animation-player-2' as const;
export const MAX_ANIMATION_PNG_PIXELS2 = 16 * 1024 * 1024;
/** ASCII JSON is XML-safe even for opaque IDs containing noncharacters. JSON.parse
 * restores every code unit; native identity and source hashing remain unchanged. */
function sceneMetadataJson(scene: Scene2) {
  return JSON.stringify(sceneMetadata(scene)).replace(
    /[^\x20-\x7e]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
function sceneMetadata(scene: Scene2) {
  return {
    sourceHash: scene.contentHash,
    compositionId: scene.compositionId,
    tick: scene.tick,
    evaluatorVersion: 'animation-evaluator-2',
    playerVersion: ANIMATION_PLAYER2,
    provenance: scene.provenance,
    resources: [...new Set(scene.items.flatMap((item) => (item.asset ? [item.asset] : [])))].map(
      (asset) => ({
        id: asset.id,
        contentHash: asset.contentHash,
        mediaType: asset.mediaType,
        attribution: asset.attribution,
        license: asset.license,
      }),
    ),
  };
}
export function playableAnimationPoster(input: PlayableAnimationEmbed) {
  const inspected = inspectPlayableAnimationEmbed(input);
  const { embed } = inspected;
  const source =
    inspected.kind === 'scene2'
      ? inspected.prepared
      : prepareAnimation2(animationPlaybackContent2(embed));
  return animationSceneSvg2(
    evaluateAnimation2(
      source,
      embed.source.compositionId,
      embed.posterTick,
      embed.format === 'animation-embed-2' ? embed.inputs : [],
    ),
    undefined,
    true,
    false,
  );
}
// Prepared sources are deep-frozen, so their asset headers are inspected once.
const assetDimensions = new WeakMap<Asset2, { width: number; height: number }>();
function dimensions(asset: Asset2) {
  let value = assetDimensions.get(asset);
  if (!value) {
    const { width, height } = inspectAnimationAsset2(asset);
    value = { width, height };
    if (isDeepFrozen(asset)) assetDimensions.set(asset, value);
  }
  return value;
}
interface SceneSvgParts2 {
  /** Definitions in first-use order. Resource markup depends only on its asset and ID. */
  defs: { resource?: Asset2; markup: string }[];
  /** One top-level element per scene item, keyed by its stable instance path. */
  items: { key: string; markup: string }[];
}
/** Serialize scene elements once; static SVG and the mounted player share this markup. */
function sceneSvgParts2(
  scene: Scene2,
  prefix: string,
  embedFonts: boolean,
  bounded: (markup: string) => string,
  resourceId: (asset: Asset2, index: number) => string,
): SceneSvgParts2 {
  if (!/^[A-Za-z0-9-]+$/.test(prefix)) throw Error('Invalid scene ID prefix');
  const defs: SceneSvgParts2['defs'] = [],
    fonts = new Set<string>(),
    images = new Map<Asset2, string>(),
    clips = new Map<SceneClip2, string>(),
    keys = new Map<string, number>();
  const define = (markup: string, resource?: Asset2) =>
    defs.push({ resource, markup: bounded(markup) });
  const items = scene.items.map((item) => {
    const l = item.layer,
      instance = JSON.stringify(item.instancePath),
      common = `transform="matrix(${item.matrix.join(' ')})" opacity="${item.opacity}" data-instance="${attr(instance)}"`;
    let svg = '';
    if (l.type === 'rect')
      svg = `<rect ${common} width="${l.width}" height="${l.height}" fill="${l.fill}" stroke="${l.stroke}" stroke-width="${l.strokeWidth}"/>`;
    else if (l.type === 'path')
      svg = `<path ${common} d="${pathData(l.path)}" fill="${l.fill}" stroke="${l.stroke}" stroke-width="${l.strokeWidth}"/>`;
    else if (l.type === 'text') {
      const family = item.asset ? 'animation-font-' + item.asset.contentHash : 'sans-serif';
      if (embedFonts && item.asset && !fonts.has(family)) {
        fonts.add(family);
        define(`<style>@font-face{font-family:${family};src:url(data:${item.asset.mediaType};base64,${item.asset.base64})}</style>`);
      }
      const text = animationSvgTextData2(l);
      svg = `<text ${common} fill="${l.fill}" font-family="${family}" font-size="${l.fontSize}" xml:space="preserve">${text}</text>`;
    } else if (l.type === 'image') {
      if (!item.asset) throw Error('Missing image asset');
      let id = images.get(item.asset);
      if (!id) {
        id = resourceId(item.asset, images.size);
        images.set(item.asset, id);
        const { width, height } = dimensions(item.asset);
        define(
          `<symbol id="${id}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet"><image width="${width}" height="${height}" href="data:${item.asset.mediaType};base64,${item.asset.base64}"/></symbol>`,
          item.asset,
        );
      }
      svg = `<use ${common} width="${l.width}" height="${l.height}" href="#${id}"/>`;
    }
    for (let j = 0; j < item.clips.length; j++) {
      const clip = item.clips[j];
      let id = clips.get(clip);
      if (!id) {
        id = `${prefix}-clip-${clips.size}`;
        clips.set(clip, id);
        define(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${pathData(clip.path)}" transform="matrix(${clip.matrix.join(' ')})"/></clipPath>`);
      }
      svg = `<g clip-path="url(#${id})">${svg}</g>`;
    }
    const seen = keys.get(instance) ?? 0;
    keys.set(instance, seen + 1);
    return { key: seen ? `${instance}#${seen}` : instance, markup: bounded(svg) };
  });
  return { defs, items };
}
const svgSizeLimit = () => {
  let size = 0;
  return (markup: string) => {
    size += markup.length;
    if (size > 8 * 1024 * 1024) throw Error('Animation SVG size limit');
    return markup;
  };
};
export function animationSceneSvg2(
  scene: Scene2,
  prefix = 'animation-' + scene.contentHash.slice(0, 16) + '-' + scene.tick,
  embedFonts = true,
  includeMetadata = embedFonts,
) {
  const bounded = svgSizeLimit(),
    { defs, items } = sceneSvgParts2(
      scene,
      prefix,
      embedFonts,
      bounded,
      (_, index) => `${prefix}-image-${index}`,
    );
  const body = items.map((item) => item.markup).join('');
  const metadata = includeMetadata
    ? bounded(`<metadata>${attr(sceneMetadataJson(scene))}</metadata>`)
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" width="${scene.width}" height="${scene.height}">${metadata}<defs>${defs.map((d) => d.markup).join('')}</defs>${body}</svg>`;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Parse generated markup fragments, in order. Nodes are adopted when inserted; nodes
 * used only to patch mounted elements are never imported. */
function parseSvgFragments(markup: string[]): Element[] {
  if (!markup.length) return [];
  // Markup is constructed only from validated primitives; text/attributes are escaped.
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}">${markup.join('')}</svg>`,
    'image/svg+xml',
  );
  if (parsed.querySelector('parsererror')) throw Error('Invalid generated scene');
  const nodes = Array.from(parsed.documentElement.children);
  if (nodes.length !== markup.length) throw Error('Invalid generated scene');
  return nodes;
}
/** Update `target` in place to match freshly parsed `source`. Keeping the element
 * avoids re-instantiating `<use>` image symbols when only a transform changes. */
function patchElement(target: Element, source: Element): boolean {
  if (target.namespaceURI !== source.namespaceURI || target.localName !== source.localName)
    return false;
  for (const { namespaceURI, localName } of Array.from(target.attributes))
    if (!source.hasAttributeNS(namespaceURI, localName))
      target.removeAttributeNS(namespaceURI, localName);
  for (const { namespaceURI, localName, name, value } of Array.from(source.attributes))
    if (target.getAttributeNS(namespaceURI, localName) !== value)
      target.setAttributeNS(namespaceURI, name, value);
  const before = target.childNodes,
    after = Array.from(source.childNodes);
  if (before.length !== after.length) {
    target.replaceChildren(...after);
    return true;
  }
  after.forEach((node, i) => {
    const current = before[i];
    if (current.nodeType === Node.TEXT_NODE && node.nodeType === Node.TEXT_NODE) {
      if (current.nodeValue !== node.nodeValue) current.nodeValue = node.nodeValue;
    } else if (
      !(
        current.nodeType === Node.ELEMENT_NODE &&
        node.nodeType === Node.ELEMENT_NODE &&
        patchElement(current as Element, node as Element)
      )
    )
      current.replaceWith(node);
  });
  return true;
}
/** Mounted frame renderer. Unchanged items, image resources and clip definitions keep
 * their DOM nodes; only changed markup is parsed, so image data is decoded once. */
function sceneRenderer2(doc: Document, prefix: string, label: string) {
  const svg = doc.createElementNS(SVG_NS, 'svg'),
    resourceDefs = doc.createElementNS(SVG_NS, 'defs'),
    clipDefs = doc.createElementNS(SVG_NS, 'defs'),
    resourceIds = new Map<Asset2, string>(),
    mountedResources = new Set<Asset2>();
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.append(resourceDefs, clipDefs);
  let clipMarkup = '',
    mounted = new Map<string, { markup: string; node: Element }>();
  return {
    svg,
    /** Parses everything first; the DOM changes only after the whole frame succeeded. */
    render(scene: Scene2, tick: number) {
      const { defs, items } = sceneSvgParts2(scene, prefix, false, svgSizeLimit(), (asset) => {
        let id = resourceIds.get(asset);
        if (!id) resourceIds.set(asset, (id = `${prefix}-image-${resourceIds.size}`));
        return id;
      });
      const resources = defs.filter((d) => d.resource && !mountedResources.has(d.resource)),
        clips = defs
          .filter((d) => !d.resource)
          .map((d) => d.markup)
          .join(''),
        changed = items.filter((item) => mounted.get(item.key)?.markup !== item.markup),
        parsed = parseSvgFragments([
          ...resources.map((d) => d.markup),
          ...(clips === clipMarkup ? [] : [`<defs>${clips}</defs>`]),
          ...changed.map((item) => item.markup),
        ]);
      const resourceNodes = parsed.slice(0, resources.length),
        clipNode = clips === clipMarkup ? undefined : parsed[resources.length],
        changedNodes = new Map(
          changed.map((item, i) => [item, parsed[parsed.length - changed.length + i]]),
        );
      resourceDefs.append(...resourceNodes);
      resources.forEach((d) => mountedResources.add(d.resource!));
      if (clipNode) {
        clipDefs.replaceChildren(...clipNode.childNodes);
        clipMarkup = clips;
      }
      const next = new Map<string, { markup: string; node: Element }>();
      let cursor = clipDefs.nextSibling;
      for (const item of items) {
        const previous = mounted.get(item.key)?.node,
          parsedNode = changedNodes.get(item);
        let node = previous!;
        if (parsedNode) {
          // Replacing plain shapes is cheapest; image instances are patched in place.
          const image = previous && (previous.localName === 'use' || previous.querySelector('use'));
          if (!image || !patchElement(previous, parsedNode)) node = parsedNode;
        }
        next.set(item.key, { markup: item.markup, node });
        if (node === cursor) cursor = cursor.nextSibling;
        else svg.insertBefore(node, cursor);
      }
      while (cursor) {
        const stale = cursor;
        cursor = cursor.nextSibling;
        stale.remove();
      }
      mounted = next;
      svg.setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`);
      svg.setAttribute('data-tick', String(tick));
    },
  };
}
export async function prepareAnimationResources2(
  source: PreparedAnimation2,
  doc: Document,
  signal?: AbortSignal,
  compositionId = preparedAnimationContent2(source).rootCompositionId,
) {
  const assert = () => {
    if (signal?.aborted) throw Error('Animation preparation aborted');
  };
  assert();
  const fonts: FontFace[] = [],
    seen = new Set<string>();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const font of fonts) doc.fonts.delete(font);
    signal?.removeEventListener('abort', dispose);
  };
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    for (const asset of animationCompositionAssets2(
      preparedAnimationContent2(source),
      compositionId,
    )) {
      if (seen.has(asset.contentHash)) continue;
      seen.add(asset.contentHash);
      assert();
      const inspected = inspectAnimationAsset2(asset);
      if (asset.mediaType.startsWith('image/')) {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(inspected.bytes)], { type: asset.mediaType }),
        );
        try {
          assert();
          if (bitmap.width !== inspected.width || bitmap.height !== inspected.height)
            throw Error('Image dimension mismatch');
        } finally {
          bitmap.close();
        }
      } else {
        const face = new FontFace(
          'animation-font-' + asset.contentHash,
          new Uint8Array(inspected.bytes).buffer,
        );
        await face.load();
        assert();
        doc.fonts.add(face);
        fonts.push(face);
      }
    }
    assert();
    return Object.freeze({ dispose });
  } catch (error) {
    dispose();
    throw error;
  }
}
let playerId = 0;
export interface AnimationPlayerOptions2 {
  source: PreparedAnimation2;
  compositionId: string;
  label: string;
  inputs?: AnimationInputValues2;
  signal?: AbortSignal;
  clock?: PreviewClock;
  loop?: boolean;
  workArea?: { start: number; end: number };
  autoPlay?: boolean;
  initialTick?: number;
  onTick?(tick: number, playing: boolean): void;
  onError?(error: unknown): void;
}
export async function mountAnimationPlayer2(
  container: HTMLElement,
  options: AnimationPlayerOptions2,
) {
  const owned = deepFreeze(structuredClone(options.inputs ?? [])),
    native = preparedAnimationContent2(options.source),
    composition = native.compositions.find((c) => c.id === options.compositionId);
  if (!composition) throw Error('Missing composition');
  const initialTick = options.initialTick ?? 0;
  if (!Number.isSafeInteger(initialTick) || initialTick < 0 || initialTick > composition.duration)
    throw Error('Invalid initial tick');
  if (
    options.workArea &&
    (!Number.isSafeInteger(options.workArea.start) ||
      !Number.isSafeInteger(options.workArea.end) ||
      options.workArea.start < 0 ||
      options.workArea.start >= options.workArea.end ||
      options.workArea.end > composition.duration)
  )
    throw Error('Invalid playback work area');
  validateAnimationInputs2(native, owned);
  const controller = new AbortController(),
    relay = () => controller.abort();
  options.signal?.addEventListener('abort', relay, { once: true });
  if (options.signal?.aborted) relay();
  let resources: Awaited<ReturnType<typeof prepareAnimationResources2>>;
  try {
    resources = await prepareAnimationResources2(
      options.source,
      container.ownerDocument,
      controller.signal,
      options.compositionId,
    );
  } catch (error) {
    options.signal?.removeEventListener('abort', relay);
    throw error;
  }
  const doc = container.ownerDocument,
    win = doc.defaultView!;
  let inputs = owned,
    disposed = false;
  const holder = doc.createElement('div');
  holder.className = 'animation-player2';
  holder.style.cssText = 'width:100%;height:100%';
  const renderer = sceneRenderer2(doc, 'animation-player2-' + ++playerId, options.label);
  holder.append(renderer.svg);
  const draw = (tick: number, values = inputs) => {
    renderer.render(evaluateAnimation2(options.source, composition.id, tick, values), tick);
    // Evaluation, serialization and DOM preparation may refuse an update. The
    // private inputs and mounted frame become current together, before callbacks.
    inputs = values;
    options.onTick?.(
      tick,
      transport.playing && (options.loop || tick < (options.workArea?.end ?? composition.duration)),
    );
  };
  const transport = createPreviewTransport(
    composition.duration,
    240000,
    options.clock ?? {
      now: () => win.performance.now(),
      request: (cb) => win.requestAnimationFrame(cb),
      cancel: (id) => win.cancelAnimationFrame(id),
    },
    (tick) => {
      try {
        draw(tick);
      } catch (error) {
        dispose();
        if (options.onError) options.onError(error);
        else throw error;
      }
    },
    options.loop,
    options.workArea,
    initialTick,
  );
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)'),
    pause = () => {
      transport.pause();
      options.onTick?.(transport.tick, false);
    };
  const autoPlay = () => {
    if (!doc.hidden && !reduced.matches) transport.play();
  };
  const hidden = () => {
      if (doc.hidden) pause();
    },
    motion = () => {
      if (reduced.matches) pause();
    };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    transport.dispose();
    holder.remove();
    resources.dispose();
    controller.abort();
    doc.removeEventListener('visibilitychange', hidden);
    reduced.removeEventListener('change', motion);
    options.signal?.removeEventListener('abort', relay);
  };
  controller.signal.addEventListener('abort', dispose, { once: true });
  try {
    if (controller.signal.aborted) throw Error('Animation preparation aborted');
    draw(initialTick);
    container.append(holder);
    doc.addEventListener('visibilitychange', hidden);
    reduced.addEventListener('change', motion);
    if (options.autoPlay) autoPlay();
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
    seek: (tick: number) => {
      transport.seek(tick);
      if (disposed) throw Error('Animation rendering failed');
    },
    play: () => {
      if (doc.hidden) throw Error('Hidden Animation');
      transport.play();
    },
    pause,
    autoPlay,
    setRate: (rate: number) => transport.setRate(rate),
    setInputs: (values: AnimationInputValues2) => {
      const next = deepFreeze(structuredClone(values));
      validateAnimationInputs2(native, next);
      draw(transport.tick, next);
    },
    dispose,
  });
}
export interface AnimationFramePlan2 {
  readonly planHash: string;
  readonly sourceHash: string;
  readonly compositionId: string;
  readonly tick: number;
  readonly inputs: AnimationInputValues2;
  readonly losses: readonly { address: string; reason: string }[];
}
const framePlans = new WeakMap<AnimationFramePlan2, { source: PreparedAnimation2; svg: string }>();
export function planAnimationFrame2(
  source: PreparedAnimation2,
  compositionId: string,
  tick: number,
  inputs: AnimationInputValues2 = [],
): AnimationFramePlan2 {
  const values = deepFreeze(structuredClone(inputs)),
    scene = evaluateAnimation2(source, compositionId, tick, values);
  // A static frame is a fixed output: the system-font display stays in live playback.
  if (
    scene.items.some(
      (item) =>
        item.layer.type === 'text' &&
        !item.asset &&
        Array.from(item.layer.text).some((character) => character.codePointAt(0)! > 127),
    )
  )
    throw Error('Pin a font asset for non-ASCII text before exporting a static frame');
  const unsigned = {
    sourceHash: source.contentHash,
    compositionId,
    tick,
    inputs: values,
    losses: [
      {
        address: compositionId,
        reason:
          'Animation becomes a single static frame; motion and editable timeline are not retained.',
      },
    ],
  };
  const plan = deepFreeze({ ...unsigned, planHash: reuseHash(unsigned) });
  framePlans.set(plan, { source, svg: animationSceneSvg2(scene) });
  return plan;
}
/** Consent is tied to this exact source/time/input capture. It cannot authorize a later export plan. */
export function animationFramePreview2(plan: AnimationFramePlan2): string {
  const state = framePlans.get(plan);
  if (!state) throw Error('Unknown static export plan');
  return state.svg;
}
export async function exportAnimationFrame2(
  plan: AnimationFramePlan2,
  options: {
    acceptedPlanHash: string;
    format: 'svg' | 'png';
    document: Document;
    signal?: AbortSignal;
    canRead(): boolean;
  },
) {
  const state = framePlans.get(plan);
  if (!state || options.acceptedPlanHash !== plan.planHash)
    throw Error('Confirm the exact static export plan');
  const assert = () => {
    if (options.signal?.aborted || !options.canRead())
      throw Error('Export cancelled or read permission revoked');
  };
  assert();
  if (!['svg', 'png'].includes(options.format)) throw Error('Unsupported Animation frame format');
  const composition = preparedAnimationContent2(state.source).compositions.find(
      (c) => c.id === plan.compositionId,
    )!,
    rasterWidth = Math.ceil(composition.width),
    rasterHeight = Math.ceil(composition.height);
  if (options.format === 'png' && rasterWidth * rasterHeight > MAX_ANIMATION_PNG_PIXELS2)
    throw Error('Animation PNG output exceeds 16 Mi pixels');
  const resources = await prepareAnimationResources2(
    state.source,
    options.document,
    options.signal,
    plan.compositionId,
  );
  try {
    assert();
    const svg = new Blob([state.svg], { type: 'image/svg+xml' });
    if (options.format === 'svg') return svg;
    const image = new Image(),
      url = URL.createObjectURL(svg);
    try {
      image.src = url;
      await image.decode();
      assert();
      const scene = evaluateAnimation2(state.source, plan.compositionId, plan.tick, plan.inputs),
        canvas = options.document.createElement('canvas');
      canvas.width = rasterWidth;
      canvas.height = rasterHeight;
      const context = canvas.getContext('2d');
      if (!context) throw Error('Canvas unavailable');
      context.drawImage(image, 0, 0, rasterWidth, rasterHeight);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(Error('PNG export failed'))),
          'image/png',
        ),
      );
      assert();
      const annotated = await animationPngNotices(blob, sceneMetadataJson(scene));
      assert();
      return annotated;
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    resources.dispose();
  }
}
