import { ownReuseOptions, cloneReuseNative } from './reuse-owned';
import { applicationSnapshot } from './reuse-preparation';
import { clone } from '@editor-platform/artifact-core';
import {
  evaluate,
  type Identity,
  type Snapshot,
  type Action,
} from '@editor-platform/collaboration-core';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import { isDeck } from '@editor-platform/slide/model';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import {
  isDesign,
  createDesign,
  layoutDesign,
  type DesignElement,
} from '@editor-platform/design/model';
import {
  rejectReuse,
  reuseHash,
  validateSlotAssignment,
  type JsonValue,
  type LockedClosure,
  type ReuseInstance,
} from '@editor-platform/reuse-core';
import { saveAsTemplate } from './author';
import {
  stageInsertion,
  prepareNativeApplication,
  templateCodec,
  localTemplateSnapshot,
} from './apply';
import { type ComponentDefinition } from './reuse-definition';
import { stageComponentInsertion, retainedComponent, reusableNativeActions } from './reuse-apply';
import { reusableParts } from './reuse-native';
import { remapNative } from './native';
import type { Domain, NativeContent } from './types';

export type ComponentSlotValue =
  | { kind: 'body'; content: DocumentContent }
  | {
      kind: 'component';
      definition: ComponentDefinition;
      closure: LockedClosure<unknown>;
      inputs?: Record<string, JsonValue>;
      variant?: string;
      slots?: Record<string, ComponentSlotValue[]>;
    };
interface SlotOptions {
  state: Snapshot<NativeContent>;
  identity: Identity;
  instanceId: string;
  slotId: string;
  values: ComponentSlotValue[];
  requestId?: string;
}
/** Bound recursive input before any preparation, including object cycles from a headless caller. */
export function validateComponentSlotTree(
  values: Record<string, ComponentSlotValue[]>,
  depth = 0,
  active = new Set<object>(),
): number {
  if (depth >= 16 || active.has(values))
    rejectReuse('slot-depth', 'Nested slots exceed their depth or form a cycle');
  active.add(values);
  let deepest = depth;
  if (Object.values(values).some((slot) => !Array.isArray(slot) || slot.length > 100))
    rejectReuse('slot-count', 'Invalid slot assignments');
  for (const slot of Object.values(values))
    for (const value of slot)
      if (value.kind === 'component') {
        if (depth + 1 >= 16) rejectReuse('slot-depth', 'Nested slots exceed their depth');
        deepest = Math.max(
          deepest,
          value.slots ? validateComponentSlotTree(value.slots, depth + 1, active) : depth + 1,
        );
      }
  active.delete(values);
  return deepest;
}
async function buildComponentSlot(
  options: SlotOptions,
  parent: Pick<ReturnType<typeof retainedComponent>, 'instance' | 'definition'>,
) {
  const { state, identity } = options,
    { instance, definition } = parent;
  const slot = definition.payload.contract.slots.find((s) => s.id === options.slotId);
  if (!slot) rejectReuse('slot-missing', 'Slot is not declared', { slotId: options.slotId });
  if (!options.values.length) rejectReuse('slot-empty', 'Select content to append');
  const instances = 'reuse' in state.content ? (state.content.reuse?.instances ?? []) : [];
  const ancestry = new Set<string>();
  let parentDepth = 0;
  const visit = (current: ReuseInstance, depth: number) => {
    if (ancestry.has(current.id) || depth >= 16)
      rejectReuse('slot-depth', 'Nested instance slots exceed their depth or form a cycle');
    ancestry.add(current.id);
    parentDepth = Math.max(parentDepth, depth);
    for (const parent of instances)
      if (
        parent.id !== current.id &&
        Object.values(parent.slots)
          .flat()
          .some((root) =>
            Object.values(current.parts).some(
              (address) => address === root || address.startsWith(root + '/'),
            ),
          )
      )
        visit(parent, depth + 1);
    ancestry.delete(current.id);
  };
  visit(instance, 0);
  validateComponentSlotTree({ [options.slotId]: options.values }, parentDepth);
  const existing = instance.slots[slot.id] ?? [];
  // Count the expanded native roots after preparing the contents. At this stage
  // the input count is only a lower bound (one component may contain many blocks).
  validateSlotAssignment(
    {
      ...definition.payload.contract,
      slots: definition.payload.contract.slots.map((s) =>
        s.id === slot.id ? { ...s, min: 0 } : s,
      ),
    },
    slot.id,
    [
      ...existing.map(() => ({ domain: slot.domain, kind: slot.accepts[0] })),
      ...options.values.map((value) => ({
        domain: value.kind === 'body' ? ('document' as const) : (value.definition.domain as Domain),
        kind: value.kind,
      })),
    ],
  );
  const id = options.requestId ?? crypto.randomUUID(),
    codec = templateCodec(state.domain as Domain);
  let interim = state;
  const actions: Action[] = [],
    added: string[] = [];
  const append = (nextActions: Action[]) => {
    interim = evaluate(codec, interim, nextActions, identity.actorId, {
      immutableContent: true,
    }).state;
    actions.push(...nextActions);
  };
  for (let index = 0; index < options.values.length; index++) {
    const value = options.values[index],
      requestId = 'slot_' + reuseHash([id, slot.id, index]).slice(0, 32);
    if (isDocument(interim.content)) {
      const anchor = [...existing, ...added].at(-1) ?? instance.parts[slot.partId];
      const beforeIds = new Set(interim.content.blocks.map((b) => b.id));
      const prepared =
        value.kind === 'component'
          ? await stageComponentInsertion({
              ...value,
              state: interim,
              identity,
              reuse: 'linked',
              requestId,
              target: { afterId: anchor },
            })
          : await stageInsertion(
              await saveAsTemplate({
                domain: 'document',
                content: value.content,
                name: slot.label,
                purpose: '本文スロット',
                category: '部品',
                slots: [],
                kind: 'fragment',
              }),
              {},
              interim,
              identity,
              { afterId: anchor },
              requestId,
            );
      interim = applicationSnapshot(prepared);
      actions.push(...prepared.operation.actions);
      if (isDocument(interim.content))
        added.push(...interim.content.blocks.filter((b) => !beforeIds.has(b.id)).map((b) => b.id));
    } else if (isDeck(interim.content) && value.kind === 'component') {
      const address = instance.parts[slot.partId];
      const page = interim.content.slides.find(
        (p) => p.id === address || p.objects.some((o) => o.id === address),
      );
      const group = page?.objects.find((o) => o.id === address);
      if (
        !page ||
        (group && group.type !== 'group') ||
        value.definition.payload.slide !== 'objects'
      )
        rejectReuse('slot-target', 'Slide slots accept in-page components in a page or group');
      const before = new Set(page.objects.map((o) => o.id));
      const child = await stageComponentInsertion({
        ...value,
        state: interim,
        identity,
        reuse: 'linked',
        requestId,
        target: { slidePageId: page.id },
      });
      interim = applicationSnapshot(child);
      actions.push(...child.operation.actions);
      if (!isDeck(interim.content)) rejectReuse('slot-type', 'Expected Slide content');
      const inserted = interim.content.slides
        .find((p) => p.id === page.id)!
        .objects.filter((o) => !before.has(o.id));
      const roots = inserted.filter((o) => !o.groupId);
      if (group) {
        const rootIds = new Set(roots.map((root) => root.id));
        const next = {
          ...interim.content,
          slides: interim.content.slides.map((slide) =>
            slide.id === page.id
              ? {
                  ...slide,
                  objects: slide.objects.map((object) =>
                    rootIds.has(object.id) ? { ...object, groupId: group.id } : object,
                  ),
                }
              : slide,
          ),
        };
        append(reusableNativeActions(interim, identity, next));
      }
      added.push(...roots.map((r) => r.id));
    } else if (isWhiteboard(interim.content) && value.kind === 'component') {
      const address = instance.parts[slot.partId];
      const group = interim.content.nodes.find((n) => n.id === address),
        section = interim.content.sections?.find((s) => s.id === address);
      if ((!section && group?.kind !== 'group') || value.definition.domain !== 'whiteboard')
        rejectReuse('slot-target', 'Whiteboard slots require a native Section or group');
      const before = new Set(interim.content.nodes.map((n) => n.id));
      const child = await stageComponentInsertion({
        ...value,
        state: interim,
        identity,
        reuse: 'linked',
        requestId,
      });
      if (!isWhiteboard(child.preview)) rejectReuse('slot-type', 'Expected Whiteboard content');
      const inserted = child.preview.nodes.filter((n) => !before.has(n.id));
      if (inserted.some((n) => n.sectionId))
        rejectReuse(
          'slot-section',
          'Native Sections do not nest; use grouped nodes inside a Section',
        );
      const roots = inserted.filter((n) => !n.groupId);
      const box = (section ?? group)!.bounds,
        dx = box.x + 20 - Math.min(...inserted.map((n) => n.bounds.x)),
        dy = box.y + 20 - Math.min(...inserted.map((n) => n.bounds.y));
      interim = applicationSnapshot(child);
      actions.push(...child.operation.actions);
      const next = cloneReuseNative(interim.content);
      if (!isWhiteboard(next)) rejectReuse('slot-type', 'Expected Whiteboard content');
      for (const node of next.nodes.filter((n) => !before.has(n.id))) {
        node.bounds.x += dx;
        node.bounds.y += dy;
        if (roots.some((r) => r.id === node.id)) {
          if (section) node.sectionId = section.id;
          else node.groupId = group!.id;
        }
      }
      append(reusableNativeActions(interim, identity, next));
      added.push(...roots.map((r) => r.id));
    } else if (isDesign(interim.content) && value.kind === 'component') {
      const preparedChild = await stageComponentInsertion({
        ...value,
        state: localTemplateSnapshot('slot', 'design', createDesign()),
        identity,
        reuse: 'linked',
        requestId,
        target: { position: { x: 0, y: 0 } },
      });
      if (!isDesign(preparedChild.preview))
        rejectReuse('slot-type', 'Design slots require Design components');
      const mapped = remapNative(preparedChild.preview, new Map(), `s_${requestId}`),
        child = mapped.content;
      const next = cloneReuseNative(interim.content),
        address = instance.parts[slot.partId],
        parts = reusableParts(next);
      const frame = parts.get(address);
      if (frame?.type !== 'frame')
        rejectReuse('slot-target', 'Design component slots require a Frame', { nativeId: address });
      const scope = address.split('/').slice(0, -1).join('/');
      if (!scope) rejectReuse('slot-target', 'The slot frame must belong to the native component');
      const owner = parts.get(scope) as unknown as DesignElement | undefined;
      const component = next.components.find((c) => c.id === owner?.componentId);
      if (!component?.elements) rejectReuse('slot-target', 'Native slot component is missing');
      const frameElement = frame as unknown as DesignElement;
      const roots = child.elements.filter((e) => !e.parentId);
      for (const root of roots) {
        root.parentId = frameElement.id;
        root.bounds.x = frameElement.bounds.x + (frameElement.layout?.padding ?? 0);
        root.bounds.y = frameElement.bounds.y + (frameElement.layout?.padding ?? 0);
      }
      component.elements.push(...child.elements);
      next.components.push(...child.components);
      next.styles = [...(next.styles ?? []), ...(child.styles ?? [])];
      component.elements = layoutDesign({ ...next, elements: component.elements }).elements;
      reusableParts(next); // Check total expansion and native nesting before preparing changes.
      const nestedActions: Action[] = (child.reuse?.instances ?? []).map((nested) => ({
        type: 'reuse.instance',
        target: nested.id,
        payload: {
          value: {
            ...nested,
            parts: Object.fromEntries(
              Object.entries(nested.parts).map(([id, address]) => [id, scope + '/' + address]),
            ),
            slots: Object.fromEntries(
              Object.entries(nested.slots).map(([id, addresses]) => [
                id,
                addresses.map((address) => scope + '/' + address),
              ]),
            ),
          },
          closure: child.reuse!.closures.find((c) => c.hash === nested.closureHash),
        },
      }));
      append([...reusableNativeActions(interim, identity, next), ...nestedActions]);
      added.push(...roots.map((r) => scope + '/' + r.id));
    } else rejectReuse('slot-type', 'Unsupported native slot assignment');
  }
  if (existing.length + added.length > slot.max || existing.length + added.length < slot.min)
    rejectReuse('slot-count', 'Expanded slot exceeds its native root count', { slotId: slot.id });
  const nextInstance = {
    ...clone(instance),
    slots: { ...instance.slots, [slot.id]: [...existing, ...added] },
  };
  return { actions, instance: nextInstance, added, id, definition, slot, state: interim };
}
/** Append to a declared slot. Replacing adopted contents is a separate reviewed migration. */
export async function prepareComponentSlot(options: SlotOptions) {
  options = ownReuseOptions(options);
  const parent = retainedComponent(options.state.content, options.instanceId);
  const { actions, instance, added, id, definition, slot } = await buildComponentSlot(
    options,
    parent,
  );
  actions.push({ type: 'reuse.instance', target: instance.id, payload: { value: instance } });
  return prepareNativeApplication({
    state: options.state,
    identity: options.identity,
    id,
    summary: `${definition.name} の「${slot.label}」に追加`,
    definition: {
      templateId: definition.definitionId,
      templateVersion: definition.version,
      hash: definition.hash,
    },
    actions,
    insertedIds: added.map((address) => address.split('/')[0]),
    notices: [`スロットに${added.length}件追加します。既存の本文・入力を保持します。`],
  });
}
/** Native changes are staged privately; incomplete required-slot metadata is never committed. */
export async function prepareInitialComponentSlots(options: {
  state: Snapshot<NativeContent>;
  identity: Identity;
  definition: ComponentDefinition;
  instance: ReuseInstance;
  slots: Record<string, ComponentSlotValue[]>;
  requestId: string;
}) {
  options = ownReuseOptions(options);
  validateComponentSlotTree(options.slots);
  const actions: Action[] = [];
  let state = options.state,
    instance = options.instance;
  for (const [slotId, values] of Object.entries(options.slots)) {
    if (!options.definition.payload.contract.slots.some((s) => s.id === slotId))
      rejectReuse('slot-missing', 'Slot is not declared', { slotId });
    if (!values.length) continue;
    const prepared = await buildComponentSlot(
      {
        state,
        identity: options.identity,
        instanceId: instance.id,
        slotId,
        values,
        requestId: options.requestId + '_' + actions.length,
      },
      { definition: options.definition, instance },
    );
    state = prepared.state;
    actions.push(...prepared.actions);
    instance = prepared.instance;
  }
  for (const slot of options.definition.payload.contract.slots) {
    const count = instance.slots[slot.id]?.length ?? 0;
    if (count < slot.min || count > slot.max)
      rejectReuse('slot-required', 'Required slot content is missing or exceeds its maximum', {
        slotId: slot.id,
      });
  }
  return { actions, instance };
}
