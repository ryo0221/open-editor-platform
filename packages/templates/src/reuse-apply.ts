import { ownReuseOptions, cloneReuseNative } from './reuse-owned';
import { applicationSnapshot, exposeApplicationContent } from './reuse-preparation';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { immutableCommand } from '@editor-platform/editor-core';
import { prepareEditorCommand } from '@editor-platform/collaboration-adapters';
import { type Action, type Identity, type Snapshot } from '@editor-platform/collaboration-core';
import { isDocument } from '@editor-platform/document/model';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { dataRowReferences } from './reuse-data';
import { isDeck } from '@editor-platform/slide/model';
import {
  contentToNode,
  documentAttributeFields,
  documentAttributePatchLimit,
  documentAttributeTransform,
  nodeToContent,
  type DocumentAttributePatch,
} from '@editor-platform/document/engine';
import { Transform } from 'prosemirror-transform';
import {
  definitionRef,
  rejectReuse,
  resolveComponentProperties,
  validateClosure,
  type JsonValue,
  type LockedClosure,
  type ReuseInstance,
} from '@editor-platform/reuse-core';
import {
  materializeComponent,
  closureDefinition,
  reusablePropertyValue,
  type ComponentDefinition,
  type ReusablePayload,
} from './reuse-definition';
import {
  nativePropertyPatch,
  patchReusablePart,
  clearReusableOverride,
  reusableParts,
} from './reuse-native';
import { remapNative } from './native';
import { sealDefinition } from './engine';
import {
  stageInsertion,
  prepareNativeApplication,
  stageNativeApplication,
  templateCodec,
  type TemplateTarget,
} from './apply';
import type { Domain, NativeContent } from './types';
import {
  prepareInitialComponentSlots,
  validateComponentSlotTree,
  type ComponentSlotValue,
} from './reuse-slots';

export function retainedComponent(content: NativeContent, instanceId: string) {
  const state = 'reuse' in content ? content.reuse : undefined;
  const instance = state?.instances.find((i) => i.id === instanceId);
  const closure = state?.closures.find((c) => c.hash === instance?.closureHash);
  if (!instance || !closure)
    rejectReuse('instance-missing', 'Linked instance or retained closure is missing', {
      instanceId,
    });
  return {
    instance,
    closure,
    definition: closureDefinition<ReusablePayload>(closure, instance.ref),
  };
}
type ComponentInsertionOptions = {
  definition: ComponentDefinition;
  closure: LockedClosure<unknown>;
  state: Snapshot<NativeContent>;
  identity: Identity;
  inputs?: Record<string, JsonValue>;
  variant?: string;
  mode?: string;
  reuse: 'copy' | 'linked';
  target?: TemplateTarget;
  requestId?: string;
  slots?: Record<string, ComponentSlotValue[]>;
};
export async function prepareComponentInsertion(options: ComponentInsertionOptions) {
  return exposeApplicationContent(await stageComponentInsertion(options));
}
/** Internal child preparation retains immutable previews; it grants no authority receipt. */
export async function stageComponentInsertion(options: ComponentInsertionOptions) {
  options = ownReuseOptions(options);
  const { definition: d, state, identity } = options,
    id = options.requestId ?? crypto.randomUUID();
  const closure = await validateClosure<unknown>(options.closure);
  validateComponentSlotTree(options.slots ?? {});
  if (!['design', 'document', 'slide', 'whiteboard', 'data'].includes(d.domain))
    rejectReuse('component-domain', 'Native adapter is not available');
  const expanded = await materializeComponent(
    d,
    closure,
    options.inputs ?? {},
    options.variant,
    options.mode,
    'reuse' in state.content ? state.content.reuse?.artifactMode : undefined,
  );
  if (isStructuredData(expanded.content) && isStructuredData(state.content)) {
    const rowRefs = dataRowReferences(expanded.content);
    if (
      Object.keys(options.target?.rowMapping ?? {}).some((id) => !rowRefs.includes(id)) ||
      Object.keys(options.target?.fieldMapping ?? {}).some(
        (id) =>
          !isStructuredData(expanded.content) || !expanded.content.columns.some((c) => c.id === id),
      )
    )
      rejectReuse('data-mapping', 'Unknown source field or record binding');
    for (const rowId of rowRefs)
      if (!state.content.rows.some((r) => r.id === options.target?.rowMapping?.[rowId]))
        rejectReuse('row-mapping', 'Select an existing target record for each relation reference', {
          nativeId: rowId,
        });
    if (
      d.payload.data === 'view' &&
      expanded.content.columns.some((c) => typeof options.target?.fieldMapping?.[c.id] !== 'string')
    )
      rejectReuse('field-mapping', 'View reuse requires explicit existing field bindings');
  }
  const template = await sealDefinition({ ...d.payload.template, content: expanded.content });
  if (
    isDeck(expanded.content) &&
    (d.payload.slide === 'objects' ? !options.target?.slidePageId : !!options.target?.slidePageId)
  )
    rejectReuse(
      'slide-target',
      'In-page objects require a destination page; page layouts insert whole pages',
    );
  const prepared = await stageInsertion(
    template,
    {},
    state,
    identity,
    { ...options.target, preserveEmptyAssets: true },
    id,
  );
  const ids = prepared.nativeMapping
    ? new Map(Object.entries(prepared.nativeMapping))
    : remapNative(expanded.content, new Map(), `t_${id}`).ids;
  if (isDeck(expanded.content) && d.payload.slide === 'objects')
    ids.set(expanded.content.slides[0].id, options.target!.slidePageId!);
  let instance: ReuseInstance = {
    id: 'reuse_' + id,
    ref: definitionRef(d),
    closureHash: closure.hash,
    ...(options.variant ? { variant: options.variant } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    inputs: clone(options.inputs ?? {}),
    overrides: Object.fromEntries(
      prepared.mapping
        .filter((m) => m.action === 'reuse')
        .flatMap((m) =>
          d.payload.contract.parts
            .filter((p) => p.nativeId === m.sourceId)
            .map((p) => [p.id, { schema: true }]),
        ),
    ),
    slots: {},
    nativeIds: Object.fromEntries(ids),
    parts: Object.fromEntries(
      d.payload.contract.parts.map((p) => [
        p.id,
        ids.get(p.nativeId) ??
          p.nativeId
            .split('/')
            .map((id) => ids.get(id) ?? id)
            .join('/'),
      ]),
    ),
  };
  const filled = await prepareInitialComponentSlots({
    state: applicationSnapshot(prepared),
    identity,
    instance,
    definition: d,
    slots: options.slots ?? {},
    requestId: id + '_slots',
  });
  instance = filled.instance;
  const actions = [...prepared.operation.actions, ...filled.actions];
  const result = stageNativeApplication({
    state,
    identity,
    id,
    summary: `${d.name} v${d.version} を${options.reuse === 'linked' ? 'リンクして' : 'コピーで'}挿入`,
    definition: prepared.definition,
    actions:
      options.reuse === 'copy'
        ? actions.filter((a) => a.type !== 'reuse.instance')
        : [
            ...actions,
            { type: 'reuse.instance', target: instance.id, payload: { value: instance, closure } },
          ],
    insertedIds: prepared.insertedIds,
    reads: [...prepared.operation.conditions.map((c) => c.key), 'reuse/mode'],
    notices: [
      options.reuse === 'linked'
        ? '採用した版・依存部品・画像を成果物内に保持します。公開版の変更は自動適用されません。'
        : '本文・子部品を含め、独立したコピーとして挿入します。',
    ],
  });
  return {
    ...result,
    mapping: prepared.mapping,
    ...(prepared.nativeMapping ? { nativeMapping: prepared.nativeMapping } : {}),
  };
}
/** Attribute edits do not own or replace Document body text. Targeted text edits use engine steps. */
export function reusableNativeActions(
  state: Snapshot<NativeContent>,
  identity: Identity,
  next: NativeContent,
): Action[] {
  if (isDocument(state.content) && isDocument(next)) {
    const before = state.content;
    if (
      canonicalJson(before.blocks.map((b) => b.id)) !== canonicalJson(next.blocks.map((b) => b.id))
    )
      rejectReuse(
        'structure-conflict',
        'Document structure requires an explicit slot/structural edit',
      );
    const patches: DocumentAttributePatch[] = [];
    before.blocks.forEach((block, i) => {
      const after = next.blocks[i],
        values: DocumentAttributePatch['values'] = {};
      for (const key of documentAttributeFields)
        if (
          canonicalJson(block[key as keyof typeof block]) !==
          canonicalJson(after[key as keyof typeof after])
        )
          values[key] = after[key as keyof typeof after] ?? null;
      if (Object.keys(values).length) patches.push({ id: block.id, values });
    });
    const attributeActions: Action[] = [];
    let attributed = before,
      attributeSteps = 0;
    for (let offset = 0; offset < patches.length; offset += documentAttributePatchLimit) {
      const batch = patches.slice(offset, offset + documentAttributePatchLimit);
      const attributes = documentAttributeTransform(attributed, batch);
      attributed = nodeToContent(attributes.doc, attributed);
      attributeSteps += attributes.steps.length;
      attributeActions.push({
        type: 'document.attributes',
        target: 'text',
        payload: { patches: batch },
      });
    }
    const tr = new Transform(contentToNode(attributed)),
      wanted = contentToNode(next);
    const positions: number[] = [];
    tr.doc.forEach((_node, pos) => positions.push(pos));
    for (let i = before.blocks.length - 1; i >= 0; i--) {
      const old = tr.doc.child(i),
        value = wanted.child(i);
      if (old.type !== value.type) rejectReuse('type-conflict', 'Document block type changed');
      if (!old.content.eq(value.content)) {
        if (!['paragraph', 'heading'].includes(value.type.name))
          rejectReuse('body-conflict', 'Use semantic slot editing for this block type');
        tr.replaceWith(positions[i] + 1, positions[i] + old.nodeSize - 1, value.content);
      }
    }
    return [
      ...attributeActions,
      ...(tr.steps.length
        ? [
            {
              type: 'document.steps',
              target: 'text',
              payload: {
                version: state.engineVersion + attributeSteps,
                steps: tr.steps.map((s) => s.toJSON()),
              },
            },
          ]
        : []),
    ];
  }
  const operation = prepareEditorCommand(
    templateCodec(state.domain as Domain),
    state,
    identity,
    immutableCommand('reuse.native', '部品の属性を変更', () => next),
  );
  return operation?.actions ?? [];
}
export async function prepareComponentProperties(options: {
  state: Snapshot<NativeContent>;
  identity: Identity;
  instanceId: string;
  inputs?: Record<string, JsonValue>;
  reset?: string[];
  variant?: string | null;
  requestId?: string;
}) {
  options = ownReuseOptions(options);
  const { state, identity } = options,
    { instance, closure, definition: d } = retainedComponent(state.content, options.instanceId);
  const inputs = { ...instance.inputs, ...clone(options.inputs ?? {}) };
  for (const key of options.reset ?? []) delete inputs[key];
  const contract = d.payload.contract,
    variant = options.variant === null ? undefined : (options.variant ?? instance.variant);
  const old = resolveComponentProperties(contract, instance.inputs, instance.variant),
    resolved = resolveComponentProperties(contract, inputs, variant);
  // Full validation occurs before making any current-native changes.
  const artifactMode = 'reuse' in state.content ? state.content.reuse?.artifactMode : undefined;
  await materializeComponent(d, closure, inputs, variant, instance.mode, artifactMode);
  const next = cloneReuseNative(state.content),
    bodyReads: string[] = [];
  const currentParts = reusableParts(state.content);
  const oldNative = reusableParts(
    (
      await materializeComponent(
        d,
        closure,
        instance.inputs,
        instance.variant,
        instance.mode,
        artifactMode,
      )
    ).content,
  );
  for (const property of contract.properties) {
    const explicit =
      Object.hasOwn(options.inputs ?? {}, property.id) || options.reset?.includes(property.id);
    if (
      !explicit &&
      canonicalJson(old.values[property.id]) === canonicalJson(resolved.values[property.id])
    )
      continue;
    for (const target of property.targets) {
      const address = instance.parts[target.partId];
      if (!address)
        rejectReuse('part-missing', 'Instance part mapping is missing', {
          instanceId: instance.id,
          partId: target.partId,
        });
      if (!explicit && ['text', 'rich'].includes(target.field)) {
        const current = currentParts.get(address);
        const prototype = oldNative.get(
          contract.parts.find((p) => p.id === target.partId)!.nativeId,
        );
        const body = (part: Record<string, unknown> | undefined) =>
          part?.rich ?? part?.runs ?? [{ text: part?.text ?? '' }];
        if (canonicalJson(body(current)) !== canonicalJson(body(prototype))) continue;
      }
      const patch = nativePropertyPatch(
        next,
        address,
        target.field,
        property.type,
        reusablePropertyValue(d, property, resolved.values[property.id]),
      );
      if (options.reset?.includes(property.id))
        clearReusableOverride(
          next,
          address,
          target.field.includes('.') ? [target.field] : Object.keys(patch),
        );
      patchReusablePart(next, address, patch, !!explicit && !options.reset?.includes(property.id));
      if (isDocument(next) && ['text', 'rich'].includes(target.field))
        bodyReads.push('block/' + address);
    }
  }
  const value = { ...clone(instance), inputs, ...(variant ? { variant } : {}) };
  if (variant === undefined) delete value.variant;
  return prepareNativeApplication({
    state,
    identity,
    id: options.requestId ?? crypto.randomUUID(),
    summary: `${d.name} の入力・表示を変更`,
    definition: { templateId: d.definitionId, templateVersion: d.version, hash: d.hash },
    actions: [
      ...reusableNativeActions(state, identity, next),
      { type: 'reuse.instance', target: value.id, payload: { value } },
    ],
    reads: [...bodyReads, 'reuse/mode'],
    notices: ['指定した公開属性だけを変更します。本文は文字列属性を変更した場合のみ編集します。'],
  });
}
export function prepareComponentDetach(
  state: Snapshot<NativeContent>,
  identity: Identity,
  instanceId: string,
  requestId = crypto.randomUUID(),
) {
  const { instance, definition: d } = retainedComponent(state.content, instanceId);
  return prepareNativeApplication({
    state,
    identity,
    id: requestId,
    summary: `${d.name} のLibraryリンクを解除`,
    definition: { templateId: d.definitionId, templateVersion: d.version, hash: d.hash },
    actions: [{ type: 'reuse.instance', target: instance.id, payload: { value: null } }],
    notices: [
      '現在の内容・native ID・Designのローカルcomponentを保持し、Libraryとのリンクを解除します。',
    ],
  });
}
