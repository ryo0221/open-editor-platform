import { canonicalJson, clone, contentHash, newId } from '@editor-platform/artifact-core';
import { addAnnotation, type Annotation, type ElementAddress } from '@editor-platform/editor-core';
import { editorAnchor } from '@editor-platform/collaboration-adapters';
import type { Identity, Snapshot } from '@editor-platform/collaboration-core';
import {
  isFile,
  isReview,
  originalBytes,
  reviewRevision,
  type FileContent,
  type ReviewContent,
} from '@editor-platform/review-surfaces/model';
import {
  definitionRef,
  record,
  stableId,
  refKey,
  rejectReuse,
  resolveStyle,
  validateClosure,
  validateRef,
  validateReusableDefinition,
  sealReusableDefinition,
  type DefinitionRef,
  type LockedClosure,
  type ReusableDefinition,
  type TokenSet,
} from '@editor-platform/reuse-core';
import { lockReusableRoot } from './reuse-dependencies';
import {
  prepareNativeApplication,
  prepareViewPreset,
  templateCodec,
  type PreparedApplication,
} from './apply';
import { sealDefinition, validateDefinition } from './engine';
import { closureDefinition, type ReusableStylePayload } from './reuse-definition';
import type { InputField, InputValue, NativeContent, TemplateDefinition } from './types';

export interface ReusableViewPayload {
  template: TemplateDefinition;
  annotation: { body: string; color?: string };
  style?: DefinitionRef;
}
export type ReusableViewDefinition = ReusableDefinition<ReusableViewPayload>;
export interface PrivateViewAdoption {
  schemaVersion: 1;
  ref: DefinitionRef;
  closure: LockedClosure<unknown>;
  inputs: Record<string, InputValue>;
  overrides: string[];
  mode?: string;
}
/** Lives in the Host's existing private view preferences, never in source content. */
export type PrivateViewSettings = Record<string, InputValue>;
const viewKeys = (domain: string) =>
  domain === 'review' ? ['split', 'wrap', 'annotations'] : ['fit', 'zoom', 'annotations'];
const colorPattern = /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i;
const annotationDefaults = (raw: unknown): ReusableViewPayload['annotation'] => {
  if (
    !record(raw) ||
    typeof raw.body !== 'string' ||
    raw.body.length > 20000 ||
    (raw.color !== undefined && (typeof raw.color !== 'string' || !colorPattern.test(raw.color))) ||
    Object.keys(raw).some((k) => !['body', 'color'].includes(k))
  )
    rejectReuse(
      'annotation-defaults',
      'Annotation defaults contain only body and color; source, anchor, history and actor cannot be copied',
    );
  return clone(raw) as unknown as ReusableViewPayload['annotation'];
};
export async function validateReusableViewDefinition(
  raw: unknown,
): Promise<ReusableViewDefinition> {
  const d = await validateReusableDefinition<ReusableViewPayload>(raw);
  if (
    d.kind !== 'view-preset' ||
    !['review', 'file'].includes(d.domain) ||
    !record(d.payload) ||
    Object.keys(d.payload).some((k) => !['template', 'annotation', 'style'].includes(k))
  )
    rejectReuse('view-preset-schema', 'Expected a source-free Review/Viewer preset');
  const t = await validateDefinition(d.payload.template);
  if (t.domain !== d.domain || t.assets.length || t.repeats.length)
    rejectReuse(
      'view-preset-schema',
      'Display presets cannot retain source assets or repeated content',
    );
  await prepareViewPreset(t, {});
  annotationDefaults(d.payload.annotation);
  if (
    d.payload.style &&
    (d.payload.style.kind !== 'style' ||
      d.payload.style.domain !== d.domain ||
      !d.dependencies.some(
        (r) => refKey(r) === refKey(d.payload.style!) && r.hash === d.payload.style!.hash,
      ))
  )
    rejectReuse('style-dependency', 'Annotation style must be an exact declared dependency');
  return d;
}
export async function materializeReusableView(
  definition: ReusableViewDefinition,
  closure: LockedClosure<unknown>,
  inputs: Record<string, InputValue> = {},
  mode?: string,
) {
  closure = clone(closure);
  inputs = clone(inputs);
  if (mode !== undefined && (!stableId(mode) || !definition.payload.style))
    rejectReuse('view-mode', 'Mode selection requires a declared annotation style');
  const d = await validateReusableViewDefinition(definition);
  closureDefinition(closure, definitionRef(d));
  const settings = await prepareViewPreset(d.payload.template, inputs),
    annotation = annotationDefaults(d.payload.annotation);
  if (d.payload.style) {
    const style = closureDefinition<ReusableStylePayload>(closure, d.payload.style);
    if (
      style.payload.style.domain !== d.domain ||
      !style.dependencies.some(
        (r) => refKey(r) === refKey(style.payload.tokens) && r.hash === style.payload.tokens.hash,
      )
    )
      rejectReuse('style-dependency', 'Annotation style token dependency differs');
    const tokens = closureDefinition<TokenSet>(closure, style.payload.tokens);
    const resolved = resolveStyle(
      style.payload.style,
      tokens.payload,
      mode ? { instanceMode: mode } : {},
    );
    if (Object.keys(resolved.properties).some((k) => k !== 'annotation.color'))
      rejectReuse('style-target', 'Review/Viewer styles affect new annotations only');
    if (resolved.properties['annotation.color'])
      annotation.color = String(resolved.properties['annotation.color']);
  }
  return { settings, annotation };
}
export async function authorReusableViewPreset(options: {
  domain: 'review' | 'file';
  name: string;
  settings: PrivateViewSettings;
  annotation?: ReusableViewPayload['annotation'];
  libraryId?: string;
  definitionId?: string;
  version?: number;
  style?: DefinitionRef;
  dependencies?: LockedClosure<unknown>['definitions'];
}) {
  options = clone(options);
  const definitionId = options.definitionId ?? newId('view');
  const defaults: PrivateViewSettings =
    options.domain === 'review'
      ? { split: true, wrap: true, annotations: true }
      : { fit: 'page', annotations: true };
  for (const key of viewKeys(options.domain))
    if (options.settings[key] !== undefined) defaults[key] = clone(options.settings[key]);
  const labels: Record<string, string> = {
    split: '左右に分けて表示',
    wrap: '長い行を折り返す',
    annotations: '注釈を表示',
    fit: '原本の表示サイズ',
    zoom: '表示倍率',
  };
  const inputs: InputField[] = Object.entries(defaults).map(([key, value]) => ({
    key,
    label: labels[key],
    description: '自分の表示設定に適用します。',
    type: key === 'fit' ? 'enum' : key === 'zoom' ? 'number' : 'boolean',
    ...(key === 'fit' ? { options: ['page', 'width', 'actual'] } : {}),
    ...(key === 'zoom' ? { min: 0.05, max: 4 } : {}),
    default: value,
  }));
  const template = await sealDefinition({
    schemaVersion: 1,
    templateId: 'view_' + (await contentHash(definitionId)),
    templateVersion: options.version ?? 1,
    name: options.name,
    description: '原本を保持する表示・注釈作成設定',
    purpose: '個人の表示と新しい注釈の設定',
    category: '表示設定',
    tags: [options.domain, 'view'],
    locales: ['ja', 'en'],
    domain: options.domain,
    kind: 'preset',
    artifactSchema: 2,
    capabilities: ['typed-inputs', 'checked-apply'],
    targets: ['view'],
    preset: { scope: 'view', fields: defaults },
    inputs,
    sample: clone(defaults),
    bindings: inputs.map((p) => ({ slot: p.key, path: ['fields', p.key], mode: 'value' })),
    repeats: [],
    assets: [],
    overflow: { policy: 'error', maxItems: 1, minFontSize: 12 },
    preview: { renderer: 'native', description: '原本・既存注釈は変更しません。' },
  });
  const definition = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: options.libraryId ?? 'personal',
    definitionId,
    version: template.templateVersion,
    kind: 'view-preset',
    domain: options.domain,
    name: options.name,
    dependencies: options.style ? [options.style] : [],
    payload: {
      template,
      annotation: annotationDefaults(options.annotation ?? { body: '確認してください。' }),
      ...(options.style ? { style: options.style } : {}),
    },
  });
  const closure = await lockReusableRoot(definition, options.dependencies);
  await materializeReusableView(definition, closure);
  return { definition, closure };
}
export async function retainedViewPreset(settings: PrivateViewSettings) {
  const raw = clone(settings.$library);
  if (raw === undefined) return undefined;
  if (
    !record(raw) ||
    raw.schemaVersion !== 1 ||
    !record(raw.inputs) ||
    !Array.isArray(raw.overrides) ||
    !raw.overrides.every((k) => typeof k === 'string') ||
    Object.keys(raw).some(
      (k) => !['schemaVersion', 'ref', 'closure', 'inputs', 'overrides', 'mode'].includes(k),
    )
  )
    rejectReuse('view-adoption', 'Invalid private preset adoption');
  validateRef(raw.ref);
  const closure = await validateClosure<unknown>(raw.closure);
  const definition = await validateReusableViewDefinition(
    closureDefinition<ReusableViewPayload>(closure, raw.ref),
  );
  if (raw.overrides.some((k) => !viewKeys(definition.domain).includes(k as string)))
    rejectReuse('view-adoption', 'Unsupported private override');
  const adoption = raw as unknown as PrivateViewAdoption;
  await materializeReusableView(definition, closure, adoption.inputs, adoption.mode);
  return { adoption, definition, closure };
}
/** Ordinary private controls mark explicit ownership, including default-equal values. */
export function editPrivateViewSettings(
  current: PrivateViewSettings,
  patch: PrivateViewSettings,
): PrivateViewSettings {
  const next = { ...clone(current), ...clone(patch) };
  if (record(current.$library)) {
    const adoption = clone(current.$library);
    const keys = viewKeys(record(adoption.ref) ? String(adoption.ref.domain) : '');
    if (Object.keys(patch).some((key) => !keys.includes(key)))
      rejectReuse('view-setting', 'Unsupported private view setting');
    adoption.overrides = [
      ...new Set([
        ...(Array.isArray(adoption.overrides) ? (adoption.overrides as string[]) : []),
        ...Object.keys(patch),
      ]),
    ];
    next.$library = adoption as InputValue;
  }
  return next;
}
export async function prepareReusableViewPreset(options: {
  definition: ReusableViewDefinition;
  closure: LockedClosure<unknown>;
  current: PrivateViewSettings;
  inputs?: Record<string, InputValue>;
  /** null explicitly returns to the definition's default mode. */
  mode?: string | null;
  reuse: 'copy' | 'linked';
  reset?: string[];
}) {
  options = clone(options);
  if (!['copy', 'linked'].includes(options.reuse))
    rejectReuse('reuse-mode', 'Choose copy or linked');
  const closure = await validateClosure<unknown>(options.closure),
    d = await validateReusableViewDefinition(options.definition);
  const retained = await retainedViewPreset(options.current);
  if (retained && retained.definition.domain !== d.domain)
    rejectReuse('view-domain', 'Private preset domains differ');
  const inputs = { ...(retained?.adoption.inputs ?? {}), ...clone(options.inputs ?? {}) };
  if (options.reset?.some((key) => !viewKeys(d.domain).includes(key)))
    rejectReuse('view-setting', 'Cannot reset an unknown private setting');
  for (const key of options.reset ?? []) delete inputs[key];
  const mode = options.mode === null ? undefined : (options.mode ?? retained?.adoption.mode);
  const resolved = await materializeReusableView(d, closure, inputs, mode);
  const old = retained
    ? await materializeReusableView(
        retained.definition,
        retained.closure,
        retained.adoption.inputs,
        retained.adoption.mode,
      )
    : undefined;
  const settings: PrivateViewSettings = clone(options.current),
    preserved: string[] = [],
    updated: string[] = [];
  const overrides = (retained?.adoption.overrides ?? []).filter(
    (key) => !options.reset?.includes(key),
  );
  for (const [key, value] of Object.entries(resolved.settings)) {
    const explicit = Object.hasOwn(options.inputs ?? {}, key),
      reset = options.reset?.includes(key);
    if (
      !explicit &&
      !reset &&
      (overrides.includes(key) ||
        (old && canonicalJson(options.current[key]) !== canonicalJson(old.settings[key])))
    )
      preserved.push(key);
    else {
      settings[key] = clone(value);
      updated.push(key);
    }
  }
  settings.$annotation = clone(resolved.annotation);
  delete settings.$library;
  if (options.reuse === 'linked')
    settings.$library = {
      schemaVersion: 1,
      ref: definitionRef(d),
      closure,
      inputs,
      overrides,
      ...(mode ? { mode } : {}),
    } as unknown as InputValue;
  return {
    settings,
    preserved,
    updated,
    notices: [
      '個人の表示・新規注釈の既定値を変更します。原本・既存の注釈・共有履歴はそのままです。',
    ],
  };
}
export function detachReusableViewPreset(current: PrivateViewSettings) {
  const next = clone(current);
  delete next.$library;
  return next;
}
export interface AnnotationSource {
  artifactId: string;
  sourceId: string;
  revisionId: string;
  hash: string;
  address: ElementAddress;
}
export async function annotationSource(
  artifactId: string,
  content: ReviewContent | FileContent,
  address: ElementAddress,
): Promise<AnnotationSource> {
  address = clone(address);
  if (address.artifactId !== artifactId)
    rejectReuse('annotation-artifact', 'Choose a source in the current artifact');
  const region = address.region;
  let bytes: Uint8Array<ArrayBuffer>, revisionId: string;
  if (isReview(content)) {
    const file = content.files.find((f) => f.id === address.elementId);
    if (!file || region?.type !== 'lines' || !['old', 'new'].includes(region.side ?? ''))
      rejectReuse('annotation-source', 'Choose explicit comparison side and line range');
    revisionId = reviewRevision(file, region.side!);
    const text = file[region.side === 'old' ? 'oldText' : 'newText'];
    if (
      region.revisionId !== revisionId ||
      !Number.isSafeInteger(region.start) ||
      !Number.isSafeInteger(region.end) ||
      region.start < 1 ||
      region.end < region.start ||
      region.end > text.split('\n').length
    )
      rejectReuse('annotation-anchor', 'The selected revision or line range is no longer current');
    bytes = new TextEncoder().encode(text);
  } else if (isFile(content)) {
    if (address.elementId !== content.id || !region)
      rejectReuse('annotation-source', 'Choose a region of the current original file');
    revisionId = content.id;
    bytes = originalBytes(content);
    const pdf = content.mime === 'application/pdf',
      image = content.mime.startsWith('image/'),
      text =
        !image &&
        !pdf &&
        (content.mime.startsWith('text/') || /json|javascript|xml/.test(content.mime));
    const bounds =
      region.type === 'page' ? region.bounds : region.type === 'canvas' ? region : undefined;
    if (
      (pdf && (region.type !== 'page' || !Number.isSafeInteger(region.page) || region.page < 1)) ||
      (image && region.type !== 'canvas') ||
      (text &&
        (region.type !== 'lines' ||
          !Number.isSafeInteger(region.start) ||
          !Number.isSafeInteger(region.end) ||
          region.start < 1 ||
          region.end < region.start ||
          region.end > content.data.split('\n').length)) ||
      (!pdf && !image && !text) ||
      (bounds &&
        (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
          bounds.x < 0 ||
          bounds.y < 0 ||
          bounds.width <= 0 ||
          bounds.height <= 0))
    )
      rejectReuse('annotation-anchor', 'Choose a valid native region for this file type');
  } else rejectReuse('annotation-domain', 'Annotations require native Review/Viewer content');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { artifactId, sourceId: address.elementId, revisionId, hash, address: clone(address) };
}
export interface PreparedReusableAnnotation {
  source: AnnotationSource;
  annotation: Annotation;
  application: PreparedApplication;
}
/** One fresh annotation; no definition can supply an old source, actor or comment history. */
export async function prepareReusableAnnotation(options: {
  state: Snapshot<NativeContent>;
  identity: Identity;
  definition: ReusableViewDefinition;
  closure: LockedClosure<unknown>;
  source: AnnotationSource;
  body?: string;
  mode?: string;
  requestId?: string;
  createdAt?: string;
}): Promise<PreparedReusableAnnotation> {
  options = clone(options);
  const { state, identity } = options;
  if (
    !['review', 'file'].includes(state.domain) ||
    options.definition.domain !== state.domain ||
    (!isReview(state.content) && !isFile(state.content))
  )
    rejectReuse('annotation-domain', 'Preset and source domains differ');
  const current = await annotationSource(state.artifactId, state.content, options.source.address);
  if (canonicalJson(current) !== canonicalJson(options.source))
    rejectReuse(
      'annotation-stale',
      'Source, revision or anchor changed; review the current selection',
    );
  const closure = await validateClosure<unknown>(options.closure),
    resolved = await materializeReusableView(options.definition, closure, {}, options.mode);
  const body = options.body ?? resolved.annotation.body;
  if (typeof body !== 'string' || !body.trim() || body.length > 20000)
    rejectReuse('annotation-body', 'Enter a nonempty comment of at most 20000 characters');
  const id = options.requestId ?? crypto.randomUUID(),
    createdAt = options.createdAt ?? new Date().toISOString();
  const annotation = {
    ...addAnnotation({ addresses: [current.address] }, body, identity.actorId),
    id: 'reuse_thread_' + id,
    createdAt,
    comments: [
      { id: 'reuse_comment_' + id, body: body.trim(), author: identity.actorId, createdAt },
    ],
    ...(resolved.annotation.color ? { color: resolved.annotation.color } : {}),
  };
  const anchor = editorAnchor(state.domain, state.content, current.address),
    codec = templateCodec(state.domain);
  if (!codec.validateAnchor(state.content, anchor))
    rejectReuse('annotation-anchor', 'Native anchor validation failed');
  const application = prepareNativeApplication({
    state,
    identity,
    id,
    summary: '選択した原本に注釈を作成',
    definition: {
      templateId: options.definition.definitionId,
      templateVersion: options.definition.version,
      hash: options.definition.hash,
    },
    actions: [
      {
        type: 'thread.create',
        target: annotation.id,
        payload: { anchor, createdAt, ...(annotation.color ? { color: annotation.color } : {}) },
      },
      {
        type: 'thread.reply',
        target: annotation.id,
        payload: { id: annotation.comments[0].id, text: body.trim(), createdAt },
      },
    ],
    reads: [state.domain === 'review' ? current.sourceId : '*'],
    notices: [
      'この原本・版・選択範囲に新しい注釈を作成します。元のコメント・作者・履歴は複製しません。',
    ],
  });
  return { source: current, annotation, application };
}
