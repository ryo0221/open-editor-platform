import { ownReuseOptions, cloneReuseNative } from './reuse-owned';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import type { Action, Identity, Snapshot } from '@editor-platform/collaboration-core';
import { documentAttributeKey, reuseInstanceKey } from '@editor-platform/collaboration-adapters';
import { isDocument } from '@editor-platform/document/model';
import { isDesign, type DesignContent, type DesignElement } from '@editor-platform/design/model';
import { isDeck } from '@editor-platform/slide/model';
import { isWhiteboard, type WhiteboardPort } from '@editor-platform/whiteboard/model';
import {
  definitionRef,
  rejectReuse,
  resolveComponentProperties,
  validateClosure,
  stableId,
  reuseHash,
  type JsonValue,
  type LockedClosure,
  type ReuseInstance,
} from '@editor-platform/reuse-core';
import { prepareNativeApplication, type PreparedApplication } from './apply';
import { retainedComponent, reusableNativeActions } from './reuse-apply';
import {
  materializeComponent,
  componentTokenModes,
  validateComponentDefinition,
  type ComponentDefinition,
} from './reuse-definition';
import { createReusableNativeEditor, reusableParts } from './reuse-native';
import { assertNative } from './native';
import type { Domain, NativeContent } from './types';
import { previewDataComponentUpdate, type DataPartMigration } from './reuse-data';

export interface ComponentUpdateSelection {
  instanceId: string;
  choice: 'adopt' | 'pin' | 'detach';
  /** Explicit old stable ID → new stable ID. Equal stable IDs need no mapping. */
  partMapping?: Record<string, string>;
  slotMapping?: Record<string, string>;
  inputMapping?: Record<string, string>;
  /** `${oldStablePartId}:${oldPortKey}` → destination port key on the mapped node. */
  portMapping?: Record<string, string>;
  dataMigration?: Record<string, DataPartMigration>;
  rowMapping?: Record<string, string>;
  variant?: string | null;
  /** null clears the instance selection and restores Artifact/default mode inheritance. */
  mode?: string | null;
}
export interface ComponentUpdateChange {
  instanceId: string;
  partId?: string;
  field: string;
  kind: 'update' | 'preserve' | 'conflict';
  message: string;
  before?: unknown;
  after?: unknown;
}
export interface ComponentUpdatePreview {
  changes: ComponentUpdateChange[];
  conflicts: ComponentUpdateChange[];
  prepared?: PreparedApplication;
}
type Part = Record<string, unknown> & { id: string };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const designFields =
  'name fill src stroke strokeWidth dash opacity radius rotation flipX flipY locked hidden shape imageFit alt arrowhead clipContent sizing'.split(
    ' ',
  );
const nestedFields: Record<string, string[]> = {
  typography:
    'fontFamily fontSize bold italic underline strike color lineHeight letterSpacing align verticalAlign padding list overflow'.split(
      ' ',
    ),
  layout: 'direction gap padding align sizing'.split(' '),
  bounds: ['x', 'y', 'width', 'height'],
  crop: ['x', 'y', 'scale'],
  constraints: ['horizontal', 'vertical'],
  style: 'color highlight fontFamily fontSize fontWeight lineHeight spaceBefore spaceAfter'.split(
    ' ',
  ),
};
function fieldPaths(part: Part, domain: Domain) {
  if (domain === 'document')
    if (part.type === 'image') return ['src', 'alt', 'width', 'caption'];
    else
      return [
        'styleName',
        'hidden',
        'align',
        'indent',
        ...(part.type === 'heading' ? ['level'] : []),
        ...nestedFields.style.map((key) => 'style.' + key),
      ];
  if (domain === 'slide' && !part.type) return ['background', 'backgroundImage', 'hidden'];
  if (domain === 'whiteboard') {
    if ('from' in part) return ['label', 'routing', 'stroke', 'strokeWidth', 'arrowhead'];
    if (!part.kind)
      return ['title', 'background', 'locked', ...nestedFields.bounds.map((k) => 'bounds.' + k)];
    return [
      ...designFields.filter((f) => !['fill', 'clipContent', 'sizing'].includes(f)),
      'color',
      'ports',
      ...['typography', 'bounds', 'crop'].flatMap((group) =>
        nestedFields[group].map((key) => group + '.' + key),
      ),
    ];
  }
  return [
    ...designFields,
    // Other domains retain imported vector data as opaque metadata.
    ...(domain === 'design' ? ['vector'] : []),
    ...(domain === 'slide'
      ? ['typography', 'bounds', 'crop']
      : ['typography', 'layout', 'bounds', 'crop', 'constraints']
    ).flatMap((group) => nestedFields[group].map((key) => group + '.' + key)),
  ];
}
function at(part: Record<string, unknown>, path: string): unknown {
  const [field, key] = path.split('.');
  // Native text projection omits false. Omission and false both mean visible,
  // so a serialization default must not masquerade as a local override.
  if (path === 'hidden') return part.hidden ?? false;
  return key ? (part[field] as Record<string, unknown> | undefined)?.[key] : part[field];
}
function set(part: Record<string, unknown>, path: string, value: unknown) {
  const [field, key] = path.split('.');
  const owner = key
    ? ((part[field] = { ...(part[field] as object) }) as Record<string, unknown>)
    : part;
  if (value === undefined) delete owner[key ?? field];
  else owner[key ?? field] = clone(value);
  if (key && !Object.keys(owner).length) delete part[field];
}
function propertyField(field: string) {
  return field === 'visible' ? 'hidden' : field === 'rich' ? 'body' : field;
}
/** Presence, including a value equal to the base, owns the field. */
function explicitNativeFields(content: DesignContent, address: string) {
  const [root, ...ids] = address.split('/');
  let owner = content.elements.find((e) => e.id === root),
    override: Partial<DesignElement> | undefined;
  for (const id of ids) {
    override = owner?.overrides?.[id];
    owner = override as DesignElement | undefined;
  }
  const fields = new Set<string>();
  for (const [field, value] of Object.entries(override ?? {})) {
    if (nestedFields[field] && value && typeof value === 'object')
      Object.keys(value).forEach((key) => fields.add(field + '.' + key));
    else fields.add(field);
  }
  return fields;
}
function nativeReadKeys(content: NativeContent, parts: ReturnType<typeof reusableParts>) {
  if (isDocument(content))
    return (address: string, fields: string[]) =>
      [...new Set(['$exists', ...fields.map((f) => f.split('.')[0])])]
        .filter((f) => f !== 'body')
        .map((f) => documentAttributeKey(address, f));
  if (isDesign(content))
    return (address: string, fields: string[]) => {
      const [root, ...path] = address.split('/');
      if (!path.length)
        return ['id', ...new Set(fields.map((f) => f.split('.')[0]))].map(
          (f) => `entity:elements:${root}/${f}`,
        );
      const owner = parts.get([root, ...path.slice(0, -1)].join('/'));
      return [
        `entity:components:${owner?.componentId}/elements`,
        `entity:elements:${root}/overrides`,
      ];
    };
  const collections = new Map<string, string>();
  if (isDeck(content)) {
    for (const page of content.slides) {
      if (!collections.has(page.id)) collections.set(page.id, 'pages');
      for (const object of page.objects)
        if (!collections.has(object.id)) collections.set(object.id, 'objects@' + page.id);
    }
  } else if (isWhiteboard(content)) {
    for (const [collection, entries] of [
      ['nodes', content.nodes],
      ['connectors', content.connectors],
      ['sections', content.sections ?? []],
    ] as const)
      for (const item of entries)
        if (!collections.has(item.id)) collections.set(item.id, collection);
  }
  return (address: string, fields: string[]) => {
    const collection = collections.get(address);
    return collection
      ? ['id', ...new Set(fields.map((f) => f.split('.')[0]))].map(
          (f) => `entity:${collection}:${address}/${f}`,
        )
      : [];
  };
}

/** Three-way adoption produces only the existing native prepared transaction.
 * No catalog lookup occurs during rendering or apply. Unresolved migrations are reviewable. */
export interface ComponentUpdateOptions {
  state: Snapshot<NativeContent>;
  identity: Identity;
  definition: ComponentDefinition;
  closure: LockedClosure<unknown>;
  selections: ComponentUpdateSelection[];
  swap?: boolean;
  requestId?: string;
}
export async function previewComponentUpdate(
  options: ComponentUpdateOptions,
): Promise<ComponentUpdatePreview> {
  return previewUpdate(ownReuseOptions(options));
}
const selectionFields = [
  'instanceId',
  'choice',
  'partMapping',
  'slotMapping',
  'inputMapping',
  'portMapping',
  'variant',
  'dataMigration',
  'rowMapping',
  'mode',
];

/** Rejects unknown choices, fields, modes and mappings before any selection is staged. */
function validateUpdateSelections(
  content: NativeContent,
  selections: ComponentUpdateSelection[],
  definition: ComponentDefinition,
) {
  if (!selections.length || new Set(selections.map((s) => s.instanceId)).size !== selections.length)
    rejectReuse('update-selection', 'Select unique linked instances');
  for (const selection of selections) {
    if (
      !['adopt', 'pin', 'detach'].includes(selection.choice) ||
      Object.keys(selection).some((key) => !selectionFields.includes(key))
    )
      rejectReuse('update-selection', 'Invalid update choice or selection field');
    if (selection.mode !== undefined && selection.mode !== null && !stableId(selection.mode))
      rejectReuse('token-mode', 'Invalid instance mode');
    const old = retainedComponent(content, selection.instanceId).definition.payload.contract;
    for (const [key, field] of [
      ['partMapping', 'parts'],
      ['slotMapping', 'slots'],
      ['inputMapping', 'properties'],
    ] as const)
      for (const [from, to] of Object.entries(selection[key] ?? {}))
        if (
          !old[field].some((value) => value.id === from) ||
          typeof to !== 'string' ||
          !definition.payload.contract[field].some((value) => value.id === to)
        )
          rejectReuse('update-mapping', 'Unknown mapping source or destination', { path: key });
  }
}

type AddChange = (
  kind: ComponentUpdateChange['kind'],
  field: string,
  message: string,
  partId?: string,
  before?: unknown,
  after?: unknown,
) => void;

function changeRecorder(changes: ComponentUpdateChange[], instanceId: string): AddChange {
  return (kind, field, message, partId, before, after) => {
    changes.push({
      instanceId,
      kind,
      field,
      message,
      ...(partId ? { partId } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  };
}

/** The private staging copy and lookups shared by every selected instance. */
function createUpdateRun(
  options: ComponentUpdateOptions,
  definition: ComponentDefinition,
  closure: LockedClosure<unknown>,
  artifactContext?: { mode?: string },
) {
  const { state } = options;
  const next = cloneReuseNative(state.content);
  // Port and endpoint changes form one native transaction. Keep the initial lookup
  // while privately staging them; intermediate port/connector pairs may be invalid.
  const boardNext = isWhiteboard(next) ? next : undefined;
  const currentParts = reusableParts(state.content);
  return {
    options,
    state,
    definition,
    closure,
    artifactContext,
    next,
    changes: [] as ComponentUpdateChange[],
    actions: [] as Action[],
    reads: [] as string[],
    boardNext,
    boardParts: boardNext ? reusableParts(boardNext) : undefined,
    editor: createReusableNativeEditor(next),
    currentParts,
    designCurrent: isDesign(state.content) ? state.content : undefined,
    documentCurrent: isDocument(state.content) ? state.content : undefined,
    deckCurrent: isDeck(state.content) ? state.content : undefined,
    boardCurrent: isWhiteboard(state.content) ? state.content : undefined,
    readKeys: nativeReadKeys(state.content, currentParts),
  };
}
type UpdateRun = ReturnType<typeof createUpdateRun>;
type Retained = ReturnType<typeof retainedComponent>;
type Contract = ComponentDefinition['payload']['contract'];

/** Maps retained parts, inputs and slots onto the new contract, recording conflicts. */
function mapInstanceStructure(
  selection: ComponentUpdateSelection,
  instance: Retained['instance'],
  contract: Contract,
  oldContract: Contract,
  add: AddChange,
) {
  const parts: Record<string, string> = {};
  const previousPart = new Map<string, string>();
  for (const oldPart of oldContract.parts) {
    const id = selection.partMapping?.[oldPart.id] ?? oldPart.id;
    if (!contract.parts.some((p) => p.id === id)) {
      add(
        'conflict',
        'parts',
        '部品が削除されています。対応先を指定するか、旧版維持・リンク解除を選んでください。',
        oldPart.id,
      );
      continue;
    }
    if (parts[id]) {
      add('conflict', 'parts', '複数の部品を同じ対応先に割り当てることはできません。', id);
      continue;
    }
    parts[id] = instance.parts[oldPart.id];
    previousPart.set(id, oldPart.id);
  }
  for (const part of contract.parts)
    if (!parts[part.id])
      add('conflict', 'parts', '追加された部品には明示的な構造移行が必要です。', part.id);
  const inputs = mapInputs(selection, instance, contract, oldContract, add);
  const slots = mapSlots(selection, instance, contract, oldContract, add, parts);
  return { parts, slots, inputs, previousPart };
}

/** Retains inputs whose mapped property keeps its type. */
function mapInputs(
  selection: ComponentUpdateSelection,
  instance: Retained['instance'],
  contract: Contract,
  oldContract: Contract,
  add: AddChange,
) {
  const inputs: Record<string, JsonValue> = {};
  for (const [oldId, value] of Object.entries(instance.inputs)) {
    const id = selection.inputMapping?.[oldId] ?? oldId;
    const before = oldContract.properties.find((p) => p.id === oldId),
      after = contract.properties.find((p) => p.id === id);
    if (!before || !after || before.type !== after.type || Object.hasOwn(inputs, id))
      add(
        'conflict',
        'input:' + oldId,
        '入力の型・対応先が変わりました。入力を保持できる対応先を指定してください。',
      );
    else inputs[id] = clone(value);
  }
  return inputs;
}

/** Retains slot content whose mapped slot keeps its domain, kinds, part and limits. */
function mapSlots(
  selection: ComponentUpdateSelection,
  instance: Retained['instance'],
  contract: Contract,
  oldContract: Contract,
  add: AddChange,
  parts: Record<string, string>,
) {
  const slots: Record<string, string[]> = {};
  for (const [oldId, roots] of Object.entries(instance.slots)) {
    const id = selection.slotMapping?.[oldId] ?? oldId;
    const before = oldContract.slots.find((s) => s.id === oldId),
      after = contract.slots.find((s) => s.id === id);
    if (!roots.length && !after) continue;
    if (
      !before ||
      !after ||
      Object.hasOwn(slots, id) ||
      after.domain !== before.domain ||
      before.accepts.some((kind) => !after.accepts.includes(kind)) ||
      parts[after.partId] !== instance.parts[before.partId]
    )
      add(
        'conflict',
        'slot:' + oldId,
        'スロットの型・位置・対応先が変わりました。本文を保持できる対応先が必要です。',
      );
    else slots[id] = clone(roots);
  }
  for (const slot of contract.slots) {
    const count = slots[slot.id]?.length ?? 0;
    if (count < slot.min || count > slot.max)
      add('conflict', 'slot:' + slot.id, '保持する内容が新版スロットの個数制限に合いません。');
  }
  return slots;
}

/** One adopted instance: its mapped structure and both materialized native graphs. */
interface Adoption {
  run: UpdateRun;
  selection: ComponentUpdateSelection;
  instance: Retained['instance'];
  old: Retained['definition'];
  contract: Contract;
  oldContract: Contract;
  add: AddChange;
  parts: Record<string, string>;
  inputs: Record<string, JsonValue>;
  previousPart: Map<string, string>;
  nativeIds: Record<string, string>;
  oldNativeIds: Record<string, string>;
  oldNative: NativeContent;
  newNative: NativeContent;
}

/** Retargets connector ports and port attachments inside one adopted Whiteboard part. */
function mergeBoardPart(
  adoption: Adoption,
  part: Contract['parts'][number],
  oldPartId: string,
  a: Part,
  b: Part,
  current: Part,
) {
  const { run, selection, contract, oldContract, add } = adoption;
  const { boardCurrent, boardNext, reads, readKeys } = run;
  if (!boardCurrent || !boardNext) return;
  for (const field of ['groupId', 'sectionId', ...('from' in a ? ['from', 'to'] : [])]) {
    const previous = oldContract.parts.find((p) => p.nativeId === a[field]);
    const incoming = contract.parts.find((p) => p.nativeId === b[field]);
    if (
      (previous ? (selection.partMapping?.[previous.id] ?? previous.id) : undefined) !==
      incoming?.id
    )
      add(
        'conflict',
        field,
        'Section・グループ・接続先の構造が変わりました。対応を保持できる部品へ差し替えるか、旧版を維持してください。',
        part.id,
      );
    reads.push(...readKeys(current.id, [field]));
  }
  if ('from' in a) retargetConnectorPorts(adoption, part, a, b, current);
  if (a.kind && !same(a.ports, b.ports) && same(a.ports, current.ports))
    migratePortAttachments(adoption, part, oldPartId, b, current);
}

/** Updates an adopted connector's own ports unless the endpoint was chosen locally. */
function retargetConnectorPorts(
  adoption: Adoption,
  part: Contract['parts'][number],
  a: Part,
  b: Part,
  current: Part,
) {
  const { add } = adoption;
  const { boardNext, reads, readKeys } = adoption.run;
  if (!boardNext) return;
  const local = boardNext.connectors.find((c) => c.id === current.id)!;
  for (const field of ['fromPort', 'toPort'] as const) {
    if (same(a[field], b[field])) continue;
    reads.push(...readKeys(current.id, [field]));
    if (same(current[field], a[field]) && same(local[field], current[field])) {
      if (b[field] === undefined) delete local[field];
      else local[field] = String(b[field]);
      add(
        'update',
        field,
        '部品内部の接続portを新版へ更新します。',
        part.id,
        current[field],
        b[field],
      );
    } else add('preserve', field, '指定済みの接続先を保持します。', part.id);
  }
}

/** Moves connectors attached to removed ports onto explicitly mapped ports. */
function migratePortAttachments(
  adoption: Adoption,
  part: Contract['parts'][number],
  oldPartId: string,
  b: Part,
  current: Part,
) {
  const { selection, add } = adoption;
  const { boardCurrent, boardNext, reads } = adoption.run;
  if (!boardCurrent || !boardNext) return;
  const newPorts = b.ports as WhiteboardPort[] | undefined;
  const accepts = (key: string) =>
    ['auto', 'top', 'right', 'bottom', 'left'].includes(key) ||
    !!newPorts?.some((p) => p.key === key);
  // A concurrent attachment must force review, even when no old connector used the port.
  reads.push('order:connectors');
  for (const connector of boardCurrent.connectors) {
    for (const side of ['from', 'to'] as const) {
      reads.push(
        `entity:connectors:${connector.id}/${side}`,
        `entity:connectors:${connector.id}/${side}Port`,
      );
      const port = connector[`${side}Port`];
      if (connector[side] !== current.id || !port || accepts(port)) continue;
      const mapped = selection.portMapping?.[oldPartId + ':' + port];
      if (!mapped || !accepts(mapped)) {
        add(
          'conflict',
          'port:' + port,
          '使用中のportが削除されています。接続先portを明示するか、旧版を維持してください。',
          part.id,
        );
        continue;
      }
      boardNext.connectors.find((c) => c.id === connector.id)![`${side}Port`] = mapped;
      add(
        'update',
        `${side}Port`,
        `接続「${connector.label || connector.id}」を指定したportへ移行します。`,
        part.id,
        port,
        mapped,
      );
    }
  }
}

/** Slide parts keep their group and owning page; structural moves need explicit migration. */
function checkDeckPart(
  adoption: Adoption,
  part: Contract['parts'][number],
  a: Part,
  b: Part,
  current: Part,
) {
  const { run, selection, instance, old, contract, oldContract, add, oldNative, newNative } =
    adoption;
  const { deckCurrent } = run;
  if (!isDeck(newNative)) return;
  const oldGroup = oldContract.parts.find((p) => p.nativeId === a.groupId);
  const newGroup = contract.parts.find((p) => p.nativeId === b.groupId);
  if (
    (oldGroup ? (selection.partMapping?.[oldGroup.id] ?? oldGroup.id) : undefined) !==
      newGroup?.id ||
    (oldGroup && current.groupId !== instance.parts[oldGroup.id])
  )
    add(
      'conflict',
      'group',
      'ページ内のグループ構造が変わりました。明示的な構造移行が必要です。',
      part.id,
    );
  const oldPage = isDeck(oldNative)
    ? oldNative.slides.find((p) => p.objects.some((o) => o.id === a.id))
    : undefined;
  const newPage = newNative.slides.find((p) => p.objects.some((o) => o.id === b.id));
  if (oldPage && newPage && old.payload.slide === 'pages') {
    const owner = oldContract.parts.find((p) => p.nativeId === oldPage.id);
    const incomingOwner = contract.parts.find((p) => p.nativeId === newPage.id);
    if (
      !owner ||
      !incomingOwner ||
      (selection.partMapping?.[owner.id] ?? owner.id) !== incomingOwner.id ||
      (deckCurrent &&
        !deckCurrent.slides
          .find((p) => p.id === instance.parts[owner.id])
          ?.objects.some((o) => o.id === current.id))
    )
      add('conflict', 'page', '部品の所属ページが変わりました。', part.id);
  }
}

/**
 * Maps one part's native addresses and checks its parent/Frame scope. Returns false
 * when a nesting change needs explicit migration.
 */
function mapPartScope(
  adoption: Adoption,
  part: Contract['parts'][number],
  oldAddress: string,
  a: Part,
  b: Part,
  current: Part,
) {
  const { run, selection, contract, oldContract, add, parts, nativeIds, oldNativeIds } = adoption;
  const { designCurrent } = run;
  const segments = (address: string) => (designCurrent ? address.split('/') : [address]);
  const sourceIds = segments(part.nativeId),
    targetIds = segments(parts[part.id]);
  if (sourceIds.length > targetIds.length) {
    add('conflict', 'scope', 'ネスト構造の変更には明示的な移行が必要です。', part.id);
    return false;
  }
  sourceIds.forEach((id, index) => {
    nativeIds[id] = targetIds[targetIds.length - sourceIds.length + index];
  });
  segments(oldAddress).forEach((id, index, ids) => {
    oldNativeIds[id] = targetIds[targetIds.length - ids.length + index];
  });
  if (typeof b.componentId === 'string' && typeof current.componentId === 'string')
    nativeIds[b.componentId] = current.componentId;
  if (typeof a.componentId === 'string' && typeof current.componentId === 'string')
    oldNativeIds[a.componentId] = current.componentId;
  if (typeof b.styleId === 'string' && typeof current.styleId === 'string')
    nativeIds[b.styleId] = current.styleId;
  if (typeof a.styleId === 'string' && typeof current.styleId === 'string')
    oldNativeIds[a.styleId] = current.styleId;
  // Parent/scope changes never become positional guesses.
  const oldParent = oldContract.parts.find(
    (p) => p.nativeId === segments(oldAddress).slice(0, -1).join('/'),
  );
  const newParent = contract.parts.find(
    (p) => p.nativeId === segments(part.nativeId).slice(0, -1).join('/'),
  );
  const frameAddress = (address: string, parent: unknown) =>
    typeof parent === 'string' ? [...segments(address).slice(0, -1), parent].join('/') : undefined;
  const oldFrame = oldContract.parts.find(
    (p) => p.nativeId === frameAddress(oldAddress, a.parentId),
  );
  const newFrame = contract.parts.find(
    (p) => p.nativeId === frameAddress(part.nativeId, b.parentId),
  );
  if (
    (oldParent ? (selection.partMapping?.[oldParent.id] ?? oldParent.id) : undefined) !==
      newParent?.id ||
    (oldFrame ? (selection.partMapping?.[oldFrame.id] ?? oldFrame.id) : undefined) !== newFrame?.id
  )
    add('conflict', 'parent', '部品の親・Frame構造が変わりました。', part.id);
  return true;
}

/** Fields the instance owns: explicit native fields, overrides and bound inputs. */
function ownedFields(adoption: Adoption, part: Contract['parts'][number], oldPartId: string) {
  const { run, instance, contract, parts, inputs } = adoption;
  const { designCurrent } = run;
  const owned = designCurrent
    ? explicitNativeFields(designCurrent, parts[part.id])
    : new Set<string>();
  for (const [field] of Object.entries(instance.overrides[oldPartId] ?? {})) owned.add(field);
  for (const property of contract.properties)
    if (Object.hasOwn(inputs, property.id))
      property.targets
        .filter((t) => t.partId === part.id)
        .forEach((t) => owned.add(propertyField(t.field)));
  return owned;
}

/** Applies new-version fields the instance has not overridden or edited, and stages them. */
function mergePartFields(
  adoption: Adoption,
  part: Contract['parts'][number],
  oldPartId: string,
  a: Part,
  b: Part,
  current: Part,
) {
  const { run, add, parts } = adoption;
  const { state, designCurrent, documentCurrent, reads, readKeys, boardParts, editor } = run;
  const owned = ownedFields(adoption, part, oldPartId);
  const merged = clone(current),
    changedFields: string[] = [],
    checkedFields: string[] = [];
  const paths = fieldPaths(b, state.domain as Domain);
  for (const path of paths) {
    const baseValue = at(a, path),
      incoming = at(b, path),
      local = at(current, path);
    if (same(baseValue, incoming)) continue;
    const rootPlacement =
      designCurrent && !part.nativeId.includes('/') && ['bounds.x', 'bounds.y'].includes(path);
    const preserve =
      rootPlacement || owned.has(path) || owned.has(path.split('.')[0]) || !same(local, baseValue);
    checkedFields.push(path);
    if (preserve)
      add(
        'preserve',
        path,
        '配置・明示的な上書き・現在の編集を保持します。',
        part.id,
        local,
        incoming,
      );
    else {
      set(merged, path, incoming);
      changedFields.push(path.split('.')[0]);
      add('update', path, '新版の属性を採用します。', part.id, local, incoming);
    }
  }
  const body = (value: Part) => value.rich ?? value.runs ?? [{ text: value.text ?? '' }];
  if (!same(body(a), body(b))) {
    if (
      documentCurrent ||
      owned.has('text') ||
      owned.has('body') ||
      owned.has('runs') ||
      !same(body(a), body(current))
    )
      add('preserve', 'body', '入力済みの本文・文字装飾を保持します。', part.id);
    else {
      merged.text = b.text;
      merged.runs = clone(b.runs);
      changedFields.push('text', 'runs');
      checkedFields.push('text', 'runs');
      add('update', 'body', '未編集の表示文字を新版へ更新します。', part.id);
    }
  }
  const patch = Object.fromEntries(
    [...new Set(changedFields)].map((field) => [field, merged[field]]),
  );
  // Read even a preserved differing field: ABA or a changed migration decision must re-preview.
  reads.push(...readKeys(parts[part.id], checkedFields));
  if (Object.keys(patch).length) {
    if (boardParts) {
      const target = boardParts.get(parts[part.id])!;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete target[key];
        else target[key] = clone(value);
      }
    } else editor.patch(parts[part.id], patch, false, true);
  }
}

/** Merges one contract part of an adopted instance into the staged native content. */
function mergeAdoptedPart(
  adoption: Adoption,
  part: Contract['parts'][number],
  oldParts: Map<string, Part>,
  newParts: Map<string, Part>,
) {
  const { run, oldContract, add, parts, previousPart } = adoption;
  const { boardCurrent, currentParts } = run;
  const oldPartId = previousPart.get(part.id)!,
    oldAddress = oldContract.parts.find((p) => p.id === oldPartId)!.nativeId;
  const a = oldParts.get(oldAddress)!,
    b = newParts.get(part.nativeId)!,
    current = currentParts.get(parts[part.id]);
  if (!current) {
    add('conflict', 'parts', '現在の部品が削除されています。', part.id);
    return;
  }
  const nativeType = (part: Part) =>
    boardCurrent ? (part.kind ?? ('from' in part ? 'connector' : 'section')) : part.type;
  if (nativeType(a) !== nativeType(b) || nativeType(a) !== nativeType(current)) {
    add(
      'conflict',
      'type',
      'native部品の型が変わりました。旧版維持・対応先の変更・リンク解除が必要です。',
      part.id,
    );
    return;
  }
  mergeBoardPart(adoption, part, oldPartId, a, b, current);
  checkDeckPart(adoption, part, a, b, current);
  if (!mapPartScope(adoption, part, oldAddress, a, b, current)) return;
  mergePartFields(adoption, part, oldPartId, a, b, current);
}

/** Updates Design local components and named styles the adopted instances share. */
function mergeDesignGraph(adoption: Adoption) {
  const { run, instance, add, nativeIds, oldNativeIds, oldNative, newNative } = adoption;
  const { next, options, state, currentParts, reads } = run;
  if (!isDesign(next) || !isDesign(oldNative) || !isDesign(newNative)) return;
  const selectedAddresses = new Set(
    options.selections
      .filter((s) => s.choice === 'adopt')
      .flatMap((s) => Object.values(retainedComponent(state.content, s.instanceId).instance.parts)),
  );
  for (const component of newNative.components) {
    const id = nativeIds[component.id] ?? instance.nativeIds?.[component.id];
    const local = next.components.find((c) => c.id === id),
      previous = oldNative.components.find(
        (c) => (oldNativeIds[c.id] ?? instance.nativeIds?.[c.id]) === id,
      );
    if (!local || !previous) {
      add('conflict', 'component:' + component.id, 'ローカルcomponentの対応先を確認してください。');
      continue;
    }
    if (
      !same(previous, component) &&
      [...currentParts].some(
        ([address, part]) => part.componentId === id && !selectedAddresses.has(address),
      )
    )
      add(
        'conflict',
        'component:' + component.id,
        'このローカルcomponentは対象外のinstanceも使用しています。両方を選ぶか、旧版を維持してください。',
      );
    for (const field of ['width', 'height', 'name'] as const) {
      if (same(previous[field], component[field])) continue;
      reads.push(`entity:components:${id}/${field}`);
      if (same(local[field], previous[field])) {
        Object.assign(local, { [field]: component[field] });
        add('update', 'component.' + field, '部品の基準寸法・名称を更新します。');
      } else add('preserve', 'component.' + field, 'ローカルcomponentの変更を保持します。');
    }
  }
  mergeDesignStyles(adoption, next, oldNative, newNative);
}

/** Styles live in each adopted native graph. Preserve locally changed style fields. */
function mergeDesignStyles(
  adoption: Adoption,
  next: DesignContent,
  oldNative: DesignContent,
  newNative: DesignContent,
) {
  const { run, instance, add, nativeIds, oldNativeIds } = adoption;
  const { reads } = run;
  for (const style of newNative.styles ?? []) {
    const nativeId = nativeIds[style.id] ?? instance.nativeIds?.[style.id];
    const local = next.styles?.find((s) => s.id === nativeId);
    const previous = oldNative.styles?.find(
      (s) => (oldNativeIds[s.id] ?? instance.nativeIds?.[s.id]) === nativeId,
    );
    if (!local || !previous) {
      add('conflict', 'style:' + style.id, '名前付きstyleの対応先を確認してください。');
      continue;
    }
    nativeIds[style.id] = local.id;
    if (!same(previous.appearance, style.appearance)) {
      reads.push(`entity:styles:${local.id}/appearance`);
      if (same(local.appearance, previous.appearance)) {
        local.appearance = clone(style.appearance);
        add('update', 'style:' + style.id, '名前付きstyleを更新します。');
      } else add('preserve', 'style:' + style.id, 'ローカルで変更されたstyleを保持します。');
    }
  }
  if ((oldNative.styles ?? []).some((s) => !(newNative.styles ?? []).some((n) => n.id === s.id)))
    add('conflict', 'styles', '名前付きstyleの削除には明示的な移行が必要です。');
}

/** Whether a Slide component keeps its insertion mode and page size; undefined off Slide. */
function deckLayout(
  old: Retained['definition'],
  definition: ComponentDefinition,
  oldNative: NativeContent,
  newNative: NativeContent,
  content: NativeContent,
) {
  if (!isDeck(oldNative) || !isDeck(newNative) || !isDeck(content)) return undefined;
  return old.payload.slide !== definition.payload.slide ||
    oldNative.width !== newNative.width ||
    oldNative.height !== newNative.height ||
    newNative.width !== content.width ||
    newNative.height !== content.height
    ? 'changed'
    : 'same';
}

/** Stages one `adopt` selection; any conflict leaves the instance unstaged. */
async function adoptSelection(
  run: UpdateRun,
  selection: ComponentUpdateSelection,
  retained: Retained,
  add: AddChange,
) {
  const { options, state, definition, closure, artifactContext, changes, actions, reads } = run;
  const { instance, definition: old, closure: oldClosure } = retained;
  if (
    !options.swap &&
    (old.libraryId !== definition.libraryId || old.definitionId !== definition.definitionId)
  )
    rejectReuse('update-identity', 'Changing a definition identity requires explicit swap');
  const beforeCount = changes.length;
  const conflicted = () => changes.slice(beforeCount).some((c) => c.kind === 'conflict');
  const contract = definition.payload.contract,
    oldContract = old.payload.contract;
  const { parts, slots, inputs, previousPart } = mapInstanceStructure(
    selection,
    instance,
    contract,
    oldContract,
    add,
  );
  const variant = selection.variant === null ? undefined : (selection.variant ?? instance.variant);
  const mode = selection.mode === null ? undefined : (selection.mode ?? instance.mode);
  const artifactMode = 'reuse' in state.content ? state.content.reuse?.artifactMode : undefined;
  try {
    resolveComponentProperties(contract, inputs, variant);
  } catch (error) {
    add('conflict', 'inputs', (error as Error).message);
  }
  if (conflicted()) return;
  const oldNative = (
    await materializeComponent(
      old,
      oldClosure,
      instance.inputs,
      instance.variant,
      instance.mode,
      artifactMode,
    )
  ).content;
  const newNative = (
    await materializeComponent(
      definition,
      closure,
      inputs,
      variant,
      mode,
      artifactContext ? artifactContext.mode : artifactMode,
    )
  ).content;
  const layout = deckLayout(old, definition, oldNative, newNative, state.content);
  if (layout === 'changed') {
    add(
      'conflict',
      'page-layout',
      'ページ寸法・挿入方式の変更は保留します。本文とノートを保持したまま旧版維持・リンク解除を選べます。',
    );
    return;
  }
  if (layout === 'same') reads.push('root/width', 'root/height');
  const adoption: Adoption = {
    run,
    selection,
    instance,
    old,
    contract,
    oldContract,
    add,
    parts,
    inputs,
    previousPart,
    nativeIds: {},
    oldNativeIds: {},
    oldNative,
    newNative,
  };
  const oldParts = reusableParts(oldNative),
    newParts = reusableParts(newNative);
  for (const part of contract.parts) mergeAdoptedPart(adoption, part, oldParts, newParts);
  mergeDesignGraph(adoption);
  if (conflicted()) return;
  const overrides = Object.fromEntries(
    Object.entries(instance.overrides).map(([id, fields]) => [
      selection.partMapping?.[id] ?? id,
      fields,
    ]),
  );
  const value: ReuseInstance = {
    ...clone(instance),
    ref: definitionRef(definition),
    closureHash: closure.hash,
    parts,
    nativeIds: adoption.nativeIds,
    slots,
    inputs,
    overrides,
    ...(variant ? { variant } : {}),
  };
  if (mode === undefined) delete value.mode;
  else value.mode = mode;
  if (variant === undefined) delete value.variant;
  actions.push({ type: 'reuse.instance', target: instance.id, payload: { value, closure } });
  reads.push(reuseInstanceKey(instance.id));
  add('update', 'version', `v${old.version} → v${definition.version} を採用します。`);
}

async function previewUpdate(
  options: ComponentUpdateOptions,
  artifactContext?: { mode?: string },
): Promise<ComponentUpdatePreview> {
  const { state, identity } = options;
  if (!['design', 'document', 'slide', 'whiteboard', 'data'].includes(state.domain))
    rejectReuse('update-domain', 'Native update adapter unavailable');
  const definition = await validateComponentDefinition(options.definition),
    closure = await validateClosure<unknown>(options.closure);
  if (definition.domain !== state.domain) rejectReuse('update-domain', 'Update domain differs');
  validateUpdateSelections(state.content, options.selections, definition);
  if (state.domain === 'data')
    return previewDataComponentUpdate({ ...options, definition, closure }, artifactContext);
  const run = createUpdateRun(options, definition, closure, artifactContext);
  const { next, changes, actions, reads } = run;
  for (const selection of options.selections) {
    const retained = retainedComponent(state.content, selection.instanceId);
    const add = changeRecorder(changes, retained.instance.id);
    if (selection.choice === 'pin') {
      add('preserve', 'version', '現在の版を維持します。');
      continue;
    }
    if (selection.choice === 'detach') {
      actions.push({
        type: 'reuse.instance',
        target: retained.instance.id,
        payload: { value: null },
      });
      add('preserve', 'link', '現在の内容を保持してリンクを解除します。');
      continue;
    }
    await adoptSelection(run, selection, retained, add);
  }
  const conflicts = changes.filter((c) => c.kind === 'conflict');
  if (conflicts.length || !actions.length) return { changes, conflicts };
  assertNative(state.domain as Domain, next);
  const prepared = prepareNativeApplication({
    state,
    identity,
    id: options.requestId ?? crypto.randomUUID(),
    summary: `${definition.name} の${options.swap ? '差し替え' : '版更新'}`,
    definition: {
      templateId: definition.definitionId,
      templateVersion: definition.version,
      hash: definition.hash,
    },
    actions: [...reusableNativeActions(state, identity, next), ...actions],
    reads: [...new Set([...reads, 'reuse/mode'])],
    notices: [
      '本文・明示的な入力・ローカル編集を保持します。差分のある属性だけを既存のUndo対象として適用します。',
    ],
  });
  return { changes, conflicts, prepared };
}

/** Change one Artifact's inherited mode in one native transaction, preserving explicit modes/body. */
export async function previewArtifactMode(options: {
  state: Snapshot<NativeContent>;
  identity: Identity;
  mode: string | null;
  requestId?: string;
}): Promise<ComponentUpdatePreview> {
  options = ownReuseOptions(options);
  const { state, identity } = options;
  const reuse = 'reuse' in state.content ? state.content.reuse : undefined;
  if (
    !reuse ||
    (!reuse.instances.length && !reuse.artifactMode) ||
    (options.mode !== null && !stableId(options.mode))
  )
    rejectReuse('token-mode', 'Select an artifact with adopted components and a valid mode');
  const groups = new Map<
    string,
    { retained: ReturnType<typeof retainedComponent>; ids: string[] }
  >();
  const declared = new Set<string>();
  if (reuse.artifactMode) declared.add(reuse.artifactMode);
  for (const instance of reuse.instances) {
    const retained = retainedComponent(state.content, instance.id);
    componentTokenModes(retained.definition, retained.closure).forEach((mode) =>
      declared.add(mode),
    );
    if (instance.mode || !retained.definition.payload.styles?.length) continue;
    const key = instance.closureHash + '/' + instance.ref.hash;
    const group = groups.get(key) ?? { retained, ids: [] };
    group.ids.push(instance.id);
    groups.set(key, group);
  }
  if (options.mode !== null && !declared.has(options.mode))
    rejectReuse('token-mode', 'The artifact mode is not declared by its adopted tokens');
  const actions: Action[] = [],
    reads = new Set<string>(['reuse/mode', 'reuse/instances']);
  const changes: ComponentUpdateChange[] = [];
  for (const instance of reuse.instances) reads.add(reuseInstanceKey(instance.id));
  for (const { retained, ids } of groups.values()) {
    const diff = await previewUpdate(
      {
        state,
        identity,
        definition: retained.definition,
        closure: retained.closure,
        selections: ids.map((instanceId) => ({ instanceId, choice: 'adopt' as const })),
      },
      { mode: options.mode ?? undefined },
    );
    changes.push(...diff.changes);
    if (diff.prepared) {
      actions.push(...diff.prepared.operation.actions);
      diff.prepared.operation.conditions.forEach((c) => reads.add(c.key));
    }
  }
  const conflicts = changes.filter((c) => c.kind === 'conflict');
  if (conflicts.length) return { changes, conflicts };
  actions.push({ type: 'reuse.mode', target: '*', payload: { value: options.mode } });
  const prepared = prepareNativeApplication({
    state,
    identity,
    id: options.requestId ?? crypto.randomUUID(),
    summary: '成果物のトークンモードを変更',
    definition: {
      templateId: 'artifact-token-mode',
      templateVersion: 1,
      hash: reuseHash([reuse, options.mode]),
    },
    actions,
    reads: [...reads],
    notices: ['個別に指定したモード・本文・局所の書式を保持し、継承する部品だけを更新します。'],
  });
  return { changes, conflicts, prepared };
}
