import { canonicalJson, clone, contentHash, newId } from '@editor-platform/artifact-core';
import {
  command,
  descendantIds,
  sameLocalRevision,
  type Bounds,
} from '@editor-platform/editor-core';
import {
  appearance,
  designDrawingProjector,
  designPaintOrder,
  deriveDesignRasterProvenance,
  applyDesignOverride,
  exportDesignSvg,
  makeDesignElement,
  validDesignRasterProvenance,
  type DesignContent,
  type DesignElement,
  type DesignRasterAncestor,
} from '@editor-platform/design/model';
import {
  creativeDesignFocus,
  type CreativeDesignAddress,
} from '@editor-platform/design/creative-proposal-diff';
import { candidateFrames, type CreativeProject } from './project';
import type { CreativeSourceCard } from './types';
import { inspectGeneratedPng } from './generation-png';
import type { HostPendingProposal, HostProposalHooks } from '@editor-platform/editor-host';
import type { CreativeWorldGenerationConnection } from './workspace/generation-execution';

export const emptyCreativeLayerPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
export interface CreativeLayerRequest {
  schemaVersion: 1;
  id: string;
  rough: {
    artifactId: string;
    versionId: string;
    frameId: string;
    contentHash: string;
    svg: string;
    rasterSources: {
      elementId: string;
      source: string;
      license: string;
      lineage?: Omit<DesignRasterAncestor, 'src'>[];
    }[];
  };
  source: { artifactId: string; versionId: string; itemId: string; elementId: string };
  settings: { name: string; fields: { label: string; value: string }[] };
  frameId: string;
  target: {
    address: CreativeDesignAddress;
    bounds: Bounds;
    placement: Bounds;
    pixelWidth: number;
    pixelHeight: number;
    transparent: boolean;
  };
  currentSvg: string;
  /** Exact saved content projected by currentSvg, separately from the rough pin. */
  currentReference: Omit<CreativeLayerRequest['rough'], 'svg'>;
  instructions: string;
  styleGuide: string;
}
export interface CreativeLayerResult {
  requestId: string;
  src: string;
  source: string;
  license: string;
  name?: string;
}
export interface CreativeLayerReviewHooks extends HostProposalHooks<DesignContent> {
  /** Live Host context assertion at preview and apply. Must be synchronous and return void. */
  assertCurrent?(): void;
}
/** Execution, credentials, scheduling and approval remain in the consuming Host. */
export interface CreativeLayerProvider {
  generate(request: Readonly<CreativeLayerRequest>, signal: AbortSignal): Promise<unknown>;
}
export function assertWorldGenerationAvailable(): never {
  throw Error('CW2未接続：この入口にはWorld対応Host・認可・実行記録がありません。');
}
export interface CreativeLayerConnection {
  context?: 'world';
  provider?: CreativeLayerProvider;
  mayRead?(): boolean;
  mayEditShared?(): boolean;
  /** Explicit World capability; bare v1 providers never receive World input. */
  world?: CreativeWorldGenerationConnection;
  sceneId?: string;
}
export interface CreativeLayerOptions {
  context?: 'world';
  instructions: string;
  styleGuide?: string;
  scale?: 1 | 2;
  transparent?: boolean;
  mayRead?: () => boolean;
  mayEditShared?: () => boolean;
}

function frameDrawings(content: DesignContent, frameId: string) {
  // Share SVG's public paint projection: effective Instance parts and hidden
  // ancestor subtrees must agree with the pixels sent to the provider.
  const included = descendantIds(content.elements, [frameId]);
  const project = designDrawingProjector(content, included);
  return designPaintOrder(content)
    .filter((e) => included.has(e.id))
    .flatMap((owner) => project(owner).map((drawing) => ({ owner, drawing })));
}
/** Same effective Instance/visibility projection as the SVG; unattributed images count too. */
export function creativeFrameHasImages(content: DesignContent, frameId: string) {
  return frameDrawings(content, frameId).some(({ drawing }) => drawing.kind === 'image');
}
function referenceImages(content: DesignContent, frameId: string) {
  return frameDrawings(content, frameId).flatMap(({ owner, drawing }) => {
    const provenance = 'provenance' in drawing ? drawing.provenance : undefined;
    return drawing.kind === 'image' &&
      validDesignRasterProvenance(provenance) &&
      provenance.src === drawing.src
      ? [{ id: owner.id, provenance }]
      : [];
  });
}
/** Effective raster samples use the same paint projection as the sent SVG. */
export function creativeWorldSampleImages(content: DesignContent, frameId: string) {
  return frameDrawings(content, frameId).flatMap(({ owner, drawing }) => {
    if (drawing.kind !== 'image') return [];
    const provenance = 'provenance' in drawing ? drawing.provenance : undefined;
    if (!validDesignRasterProvenance(provenance) || provenance.src !== drawing.src)
      throw Error('画像入り見本の出典・licenseが不正です。元資料を確認してください。');
    return [{ elementId: owner.id, provenance: clone(provenance) }];
  });
}
function referenceSources(images: ReturnType<typeof referenceImages>) {
  return images.map(({ id, provenance }) => ({
    elementId: id,
    source: provenance.source,
    license: provenance.license,
    ...(provenance.lineage
      ? { lineage: provenance.lineage.map(({ src: _src, ...ancestor }) => ancestor) }
      : {}),
  }));
}
/** Internal shared projection for request creation and retained-source preflight. */
export function projectCreativeLayerReference(content: DesignContent, frameId: string) {
  if (!candidateFrames(content).some((f) => f.id === frameId))
    throw Error('生成参照のFrameがありません。');
  return {
    svg: exportDesignSvg(content, [frameId], { padding: 0 }),
    rasterSources: referenceSources(referenceImages(content, frameId)),
  };
}
const preparedInputs = new WeakMap<
  object,
  {
    request: CreativeLayerRequest;
    sourceContentHash: string;
    ancestorBytes: number;
    assertReadable(): void;
    assertCurrent(): void;
  }
>();
const worldReviews = new WeakMap<object, CreativeLayerReviewHooks>();
const worldIntents = new WeakSet<object>();
const worldProposals = new WeakSet<object>();
const worldPreviewEditors = new WeakSet<object>();
export function declareCreativeWorldRequest(preparation: CreativeLayerPreparation) {
  if (!preparedInputs.has(preparation)) throw Error('元の生成準備がありません。');
  worldIntents.add(preparation);
}
export function isCreativeWorldLayerProposal(
  proposal: HostPendingProposal<DesignContent>,
  editor?: object,
) {
  return (
    (editor ? worldPreviewEditors.has(editor) : false) ||
    worldProposals.has(proposal.preview.proposal)
  );
}
/** Internal capability binding. Not a second public way to create World execution. */
export function bindCreativeWorldReview(
  preparation: CreativeLayerPreparation,
  hooks: CreativeLayerReviewHooks,
  assertCurrent: () => void,
) {
  const fixed = preparedInputs.get(preparation);
  if (!fixed || worldReviews.has(preparation))
    throw Error('生成依頼は既にWorld実行へ固定されています。');
  worldReviews.set(preparation, { ...hooks });
  preparation.assertCurrent = () => {
    fixed.assertCurrent();
    assertCurrent();
  };
}
/** Only an original in-session preparation can supply its bound request and source hash. */
export function readPreparedCreativeLayerInput(preparation: CreativeLayerPreparation) {
  const fixed = preparedInputs.get(preparation);
  if (!fixed || canonicalJson(preparation.request) !== canonicalJson(fixed.request))
    throw Error('公開requestと固定した生成入力の対応が変わりました。再準備してください。');
  fixed.assertCurrent();
  return {
    request: clone(fixed.request),
    sourceContentHash: fixed.sourceContentHash,
    ancestorBytes: fixed.ancestorBytes,
    assertReadable: fixed.assertReadable,
  };
}

function editorFor<T>(p: CreativeProject<T>, card: CreativeSourceCard) {
  p.assertLinked(card);
  const editor = p.editor(card);
  if (!editor || editor.readOnly || p.source.readOnly || p.saving)
    throw Error('設定画を編集できません。');
  return editor;
}
function frameFor(content: DesignContent, id: string) {
  const raw = candidateFrames(content).find((f) => f.id === id),
    f = raw && appearance(content, raw);
  if (
    !f ||
    f.hidden ||
    f.locked ||
    f.rotation ||
    f.flipX ||
    f.flipY ||
    f.reference ||
    f.crop ||
    (f.layout && f.layout.direction !== 'absolute')
  )
    throw Error('編集できる回転なしのFrameを選んでください。');
  return f;
}
function simple(e: DesignElement) {
  return (
    !e.rotation &&
    !e.flipX &&
    !e.flipY &&
    !e.reference &&
    !e.crop &&
    (!e.layout || e.layout.direction === 'absolute')
  );
}
function targetFor(content: DesignContent, frameId: string, address: CreativeDesignAddress) {
  creativeDesignFocus(content, address);
  const frame = frameFor(content, frameId);
  if (!address.componentId) {
    const raw = content.elements.find((e) => e.id === address.elementId)!,
      e = appearance(content, raw);
    if (e.type !== 'image' || e.parentId !== frameId || !simple(e))
      throw Error('Frame直下の回転なし画像レイヤーを選んでください。');
    return {
      element: e,
      placement: { ...e.bounds, x: e.bounds.x - frame.bounds.x, y: e.bounds.y - frame.bounds.y },
    };
  }
  const component = content.components.find((c) => c.id === address.componentId)!;
  const native = component.elements!.find((e) => e.id === address.elementId)!;
  const owners = content.elements.filter(
    (e) => e.type === 'instance' && e.componentId === component.id && e.parentId === frameId,
  );
  const ownerRaw = address.instanceId
    ? owners.find((e) => e.id === address.instanceId)
    : owners.length === 1
      ? owners[0]
      : undefined;
  const owner = ownerRaw && appearance(content, ownerRaw);
  if (!owner || owner.hidden || owner.locked || !simple(owner))
    throw Error('候補Instanceの対応が曖昧か、非表示・lock/変形中です。');
  const override = address.instanceId ? owner.overrides?.[native.id] : undefined;
  const e = applyDesignOverride(
    appearance(content, { ...native, ...(override?.styleId ? { styleId: override.styleId } : {}) }),
    override,
  );
  const parents = new Map(component.elements!.map((e) => [e.id, e]));
  let parent = e.parentId;
  const seen = new Set<string>();
  while (parent) {
    const raw = parents.get(parent),
      parentOverride = address.instanceId ? owner.overrides?.[parent] : undefined,
      a =
        raw &&
        applyDesignOverride(
          appearance(content, {
            ...raw,
            ...(parentOverride?.styleId ? { styleId: parentOverride.styleId } : {}),
          }),
          parentOverride,
        );
    if (!a || seen.has(parent) || a.type !== 'group' || !simple(a) || a.hidden || a.locked)
      throw Error('部位の親groupを編集できません。');
    seen.add(parent);
    parent = a.parentId;
  }
  if (e.type !== 'image' || !simple(e)) throw Error('生成の対象は回転なしの画像レイヤーです。');
  const sx = owner.bounds.width / component.width,
    sy = owner.bounds.height / component.height;
  return {
    element: e,
    placement: {
      x: owner.bounds.x - frame.bounds.x + e.bounds.x * sx,
      y: owner.bounds.y - frame.bounds.y + e.bounds.y * sy,
      width: e.bounds.width * sx,
      height: e.bounds.height * sy,
    },
  };
}
function rectangle(bounds: Bounds, frame: DesignElement) {
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x + bounds.width > frame.bounds.width ||
    bounds.y + bounds.height > frame.bounds.height
  )
    throw Error('レイヤーの範囲をFrame内に指定してください。');
}
export function addCreativeGenerationLayer<T>(
  p: CreativeProject<T>,
  card: CreativeSourceCard,
  frameId: string,
  name: string,
  bounds: Bounds,
) {
  const editor = editorFor(p, card),
    frame = frameFor(editor.content, frameId);
  if (!name.trim() || name.length > 160)
    throw Error('清書レイヤー名を160文字以内で指定してください。');
  rectangle(bounds, frame);
  const id = newId('creative-layer');
  // Inserting via the generic helper checks every hidden sibling. A rough is intentionally
  // hidden during cleanup, so this Host command authors only the new native element.
  p.execute(
    card,
    command('creative.layer.add', '清書用画像レイヤーを追加', (content) => {
      frameFor(content, frameId);
      return {
        ...content,
        elements: [
          ...content.elements,
          {
            ...makeDesignElement('image'),
            id,
            name: name.trim(),
            parentId: frameId,
            bounds: { ...bounds, x: frame.bounds.x + bounds.x, y: frame.bounds.y + bounds.y },
            src: emptyCreativeLayerPng,
            imageFit: 'fit',
          },
        ],
      };
    }),
  );
  return id;
}
export function importCreativeRough<T>(
  p: CreativeProject<T>,
  card: CreativeSourceCard,
  frameId: string,
  src: string,
  source: string,
  license: string,
) {
  const editor = editorFor(p, card),
    frame = frameFor(editor.content, frameId),
    info = inspectGeneratedPng(src);
  if (!info.visible || !validDesignRasterProvenance({ src, source, license }))
    throw Error('ラフ画像と新しい出典・利用条件を指定してください。');
  const id = newId('creative-rough'),
    base = canonicalJson(editor.content);
  const previous = editor.content.elements.filter((e) => e.parentId === frameId);
  p.execute(
    card,
    command('creative.rough.import', 'このFrameへラフ画像を配置', (content) => {
      if (canonicalJson(content) !== base) throw Error('設定画が変わりました。');
      frameFor(content, frameId);
      if (previous.some((e) => appearance(content, e).locked))
        throw Error('ラフ配置先のレイヤーがlock中です。');
      const ids = new Set(previous.map((e) => e.id));
      return {
        ...content,
        elements: [
          ...content.elements.map((e) => (ids.has(e.id) ? { ...e, hidden: true } : e)),
          {
            ...makeDesignElement('image'),
            id,
            name: 'ラフ画像',
            parentId: frameId,
            bounds: { ...frame.bounds },
            src,
            imageFit: 'fit',
            provenance: { src, source, license },
          },
        ],
      };
    }),
  );
  return id;
}
export function setCreativeRoughVisible<T>(
  p: CreativeProject<T>,
  card: CreativeSourceCard,
  visible: boolean,
) {
  const editor = editorFor(p, card),
    rough = p.binding(card)?.rough;
  const version = rough && editor.artifact.versions.find((v) => v.versionId === rough.versionId);
  if (!rough || !version) throw Error('ラフの基準版を保存してください。');
  const ids = version.content.elements
    .filter((e) => e.parentId === rough.frameId && !appearance(version.content, e).hidden)
    .map((e) => e.id);
  p.execute(
    card,
    command('creative.rough.visibility', visible ? 'ラフを表示' : 'ラフを隠す', (content) => {
      frameFor(content, rough.frameId);
      for (const id of ids)
        if (!content.elements.some((e) => e.id === id))
          throw Error('ラフの要素が削除されています。');
      return {
        ...content,
        elements: content.elements.map((e) =>
          ids.includes(e.id) ? { ...e, hidden: !visible } : e,
        ),
      };
    }),
  );
}

export async function prepareCreativeLayerGeneration<T>(
  p: CreativeProject<T>,
  card: CreativeSourceCard,
  frameId: string,
  address: CreativeDesignAddress,
  options: CreativeLayerOptions,
) {
  if (options.context === 'world') assertWorldGenerationAvailable();
  address = clone(address);
  const initialEditor = editorFor(p, card);
  p.source.flushInputs();
  initialEditor.flushInputs();
  const nativeCard = p.cards.find((c) => c.id === card.id && c.elementId === card.elementId);
  if (!nativeCard) throw Error('設定の項目がありません。');
  card = clone(nativeCard);
  const transparent = options.transparent ?? true,
    mayEditShared = options.mayEditShared;
  const editor = editorFor(p, card),
    binding = p.binding(card)!,
    pin = binding.rough;
  if (!pin) throw Error('ラフの基準版を保存してください。');
  if (p.mappingDirty || p.source.snapshot.dirty || editor.snapshot.dirty)
    throw Error('設定と設定画を保存してから生成依頼を準備してください。');
  const mayRead = options.mayRead ?? (() => true),
    shared = !!address.componentId && !address.instanceId;
  if (!mayRead() || (shared && !mayEditShared?.()))
    throw Error('この範囲の生成依頼にはHostの許可が必要です。');
  const current = editor.content,
    frame = frameFor(current, frameId),
    target = targetFor(current, frameId, address);
  if (target.element.hidden || target.element.locked)
    throw Error('対象レイヤーは非表示・lock中です。');
  rectangle(target.placement, frame);
  const version = editor.artifact.versions.find((v) => v.versionId === pin.versionId);
  if (!version || !candidateFrames(version.content).some((f) => f.id === pin.frameId))
    throw Error('ラフ基準版がありません。');
  const currentVersion = editor.artifact.versions.find(
    (v) => v.versionId === binding.design.versionId,
  );
  if (!currentVersion || canonicalJson(currentVersion.content) !== canonicalJson(current))
    throw Error('現在の設定画と保存版が一致しません。保存してから依頼してください。');
  const roughImages = referenceImages(version.content, pin.frameId);
  const currentImages = referenceImages(currentVersion.content, frameId);
  const roughProjection = projectCreativeLayerReference(version.content, pin.frameId);
  const currentProjection = projectCreativeLayerReference(currentVersion.content, frameId);
  const scale = options.scale ?? 1;
  if (![1, 2].includes(scale)) throw Error('解像度は1倍または2倍を指定してください。');
  const width = Math.round(target.element.bounds.width * scale),
    height = Math.round(target.element.bounds.height * scale);
  if (width < 1 || height < 1 || width > 2048 || height > 2048 || width * height > 4 * 1024 * 1024)
    throw Error('生成サイズは長辺2048px・4M画素までです。');
  const instructions = options.instructions.trim(),
    styleGuide = options.styleGuide?.trim() ?? '';
  if (!instructions || instructions.length > 4000 || styleGuide.length > 4000)
    throw Error('部位指示と共通指示は各4000文字までです。');
  const revision = clone(editor.revision),
    sourceRevision = clone(p.source.revision),
    identity = canonicalJson({ source: p.mapping.source, binding });
  const validate = () => {
    editorFor(p, card);
    p.source.flushInputs();
    editor.flushInputs();
    if (!mayRead() || (shared && !mayEditShared?.()))
      throw Error('生成対象の権限が変更されました。');
    if (
      !sameLocalRevision(editor.revision, revision) ||
      !sameLocalRevision(p.source.revision, sourceRevision) ||
      identity !== canonicalJson({ source: p.mapping.source, binding: p.binding(card) })
    )
      throw Error('基準版・設定・レイヤーが変更されました。生成依頼を作り直してください。');
    const latest = targetFor(editor.content, frameId, address).element;
    if (latest.hidden || latest.locked) throw Error('対象レイヤーは非表示・lock中です。');
  };
  const request: CreativeLayerRequest = {
    schemaVersion: 1,
    id: newId('creative-generation'),
    rough: {
      artifactId: editor.id,
      versionId: pin.versionId,
      frameId: pin.frameId,
      contentHash: await contentHash(version.content),
      ...roughProjection,
    },
    source: { ...p.mapping.source, itemId: card.id, elementId: card.elementId },
    settings: {
      name: card.name,
      fields: card.fields.map((f) => ({ label: f.label, value: f.value })),
    },
    frameId,
    target: {
      address: clone(address),
      bounds: clone(target.element.bounds),
      placement: target.placement,
      pixelWidth: width,
      pixelHeight: height,
      transparent,
    },
    currentSvg: currentProjection.svg,
    currentReference: {
      artifactId: editor.id,
      versionId: currentVersion.versionId,
      frameId,
      contentHash: await contentHash(currentVersion.content),
      rasterSources: currentProjection.rasterSources,
    },
    instructions,
    styleGuide,
  };
  if (new TextEncoder().encode(JSON.stringify(request)).length > 12 * 1024 * 1024)
    throw Error('生成参照が大きすぎます。Frame内の画像を小さくしてください。');
  validate();
  const sourceVersion = p.source.artifact.versions.find(
    (v) => v.versionId === request.source.versionId,
  );
  if (!sourceVersion || (await contentHash(sourceVersion.content)) !== sourceVersion.contentHash)
    throw Error('生成元の保存版・hashが不正です。');
  validate();
  const rasterLineage = (src: string) => {
    const lineage = [
      { images: roughImages, versionId: pin.versionId },
      { images: currentImages, versionId: currentVersion.versionId },
    ].flatMap(({ images, versionId }) =>
      images.flatMap(
        (image) =>
          deriveDesignRasterProvenance(image.provenance, src, {
            artifactId: editor.id,
            versionId,
            elementId: image.id,
          }).lineage!,
      ),
    );
    return [...new Map(lineage.map((ancestor) => [canonicalJson(ancestor), ancestor])).values()];
  };
  const preparation = {
    request: clone(request),
    assertCurrent: validate,
    preview(result: unknown, hooks: CreativeLayerReviewHooks = {}) {
      const world = worldReviews.get(preparation);
      if (worldIntents.has(preparation) && !world)
        throw Error('World対応Hostの制作前提を準備してください。');
      if (world) {
        if (Object.keys(hooks).length)
          throw Error('World生成のguard/receiptは差し替えられません。');
        hooks = world;
      }
      if (
        !hooks ||
        typeof hooks !== 'object' ||
        Array.isArray(hooks) ||
        Object.keys(hooks).some(
          (key) => !['assertCurrent', 'beforeApply', 'onApplied'].includes(key),
        ) ||
        [hooks.assertCurrent, hooks.beforeApply, hooks.onApplied].some(
          (fn) => fn !== undefined && typeof fn !== 'function',
        )
      )
        throw Error('生成結果のHost接続が不正です。');
      const ownedHooks = {
        assertCurrent: hooks.assertCurrent,
        beforeApply: hooks.beforeApply,
        onApplied: hooks.onApplied,
      };
      const validateReview = () => {
        validate();
        const returned: unknown = ownedHooks.assertCurrent?.();
        if (returned !== undefined) {
          if (returned && typeof (returned as PromiseLike<unknown>).then === 'function')
            void Promise.resolve(returned).catch(() => {});
          throw Error('制作前提の検査は同期処理で、戻り値なしにしてください。');
        }
        validate();
      };
      validateReview();
      const v = result as CreativeLayerResult;
      if (
        !v ||
        typeof v !== 'object' ||
        Array.isArray(v) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(v)) ||
        Object.keys(v).some(
          (k) => !['requestId', 'src', 'source', 'license', 'name'].includes(k),
        ) ||
        v.requestId !== request.id ||
        typeof v.source !== 'string' ||
        !v.source.trim() ||
        v.source.length > 1024 ||
        typeof v.license !== 'string' ||
        !v.license.trim() ||
        v.license.length > 1024 ||
        (v.name !== undefined && (typeof v.name !== 'string' || v.name.length > 160))
      )
        throw Error('生成結果の形式・依頼IDが一致しません。');
      const info = inspectGeneratedPng(v.src);
      if (info.width !== width || info.height !== height)
        throw Error(`生成画像は${width}×${height}pxにしてください。`);
      if (!info.visible) throw Error('生成画像が空です。');
      if (request.target.transparent && !info.transparent)
        throw Error('透過背景の画像を指定してください。');
      // Preserve every attributed raster of a composite reference, including its
      // retained originals. The generated pixels still get their own source/terms.
      const uniqueLineage = rasterLineage(v.src);
      const provenance = {
        ...(uniqueLineage.length ? { lineage: uniqueLineage } : {}),
        src: v.src,
        source: `${v.source} / rough ${request.rough.artifactId}@${request.rough.versionId}#${request.rough.frameId}`,
        license: v.license,
        ...(v.name ? { name: v.name } : {}),
      };
      if (!validDesignRasterProvenance(provenance))
        throw Error('新しい出典と利用条件を指定してください。');
      if (world) worldPreviewEditors.add(editor);
      try {
        const proposal = p.propose(
          card,
          [{ address: clone(address), patch: { src: v.src, provenance } }],
          [clone(address)],
          revision,
          validateReview,
          { beforeApply: ownedHooks.beforeApply, onApplied: ownedHooks.onApplied },
        );
        if (world) worldProposals.add(proposal.preview.proposal);
        return proposal;
      } finally {
        if (world) worldPreviewEditors.delete(editor);
      }
    },
  };
  preparedInputs.set(preparation, {
    request,
    sourceContentHash: sourceVersion.contentHash,
    ancestorBytes: new TextEncoder().encode(
      JSON.stringify(rasterLineage(emptyCreativeLayerPng), null, 2),
    ).length,
    // Reading a fixed input remains independent of edits/revision after its apply.
    assertReadable: () => {
      if (mayRead() !== true) throw Error('生成入力の現在の閲覧権限がありません。');
    },
    assertCurrent: validate,
  });
  return preparation;
}
export type CreativeLayerPreparation = Awaited<ReturnType<typeof prepareCreativeLayerGeneration>>;
export async function generateCreativeLayer(
  preparation: CreativeLayerPreparation,
  provider: CreativeLayerProvider,
  signal: AbortSignal,
) {
  if (worldIntents.has(preparation) || worldReviews.has(preparation))
    throw Error('World生成は対応Hostの実行入口を使ってください。裸のv1へ送信しません。');
  if (signal.aborted) throw Error('生成依頼を中止しました。');
  preparation.assertCurrent();
  // End local waiting even when a Host provider ignores AbortSignal. Its late
  // resolution/rejection is still observed, but can no longer create a proposal.
  const result = await new Promise<unknown>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(Error('生成依頼を中止しました。'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      Promise.resolve(provider.generate(clone(preparation.request), signal)).then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
  if (signal.aborted) throw Error('生成依頼を中止しました。');
  return preparation.preview(result);
}
