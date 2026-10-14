import { ownReuseOptions } from './reuse-owned';
import { clone, canonicalJson } from '@editor-platform/artifact-core';
import { reuseInstanceKey } from '@editor-platform/collaboration-adapters';
import type { Action, Identity, Snapshot } from '@editor-platform/collaboration-core';
import { isDocument } from '@editor-platform/document/model';
import { contentToNode } from '@editor-platform/document/engine';
import { isStructuredData, removeColumn } from '@editor-platform/structured-data/model';
import { Transform } from 'prosemirror-transform';
import { record } from '@editor-platform/reuse-core';
import { expandTemplate, layoutDiagnostics, sealDefinition, validateDefinition } from './engine';
import { at, setAt, remapNative, assertNative } from './native';
import { reusableNativeActions } from './reuse-apply';
import { reusableParts, reusablePartText, patchReusablePart } from './reuse-native';
import { prepareNativeApplication } from './apply';
import {
  itemPart,
  readStructure,
  structurePath,
  structureItems,
  structureAppearanceAddress,
} from './structure';
import {
  problem,
  TemplateError,
  type NativeContent,
  type InputValue,
  type StructureLayout,
  type TemplateDefinition,
  type CatalogAdapter,
} from './types';

export interface StructureChange {
  state: Snapshot<NativeContent>;
  identity: Identity;
  instanceId: string;
  /** Existing IDs retain native bodies. New IDs require the recipe's item inputs. */
  items: { id: string; [key: string]: InputValue }[];
  layout?: StructureLayout;
  relationship?: 'copy' | 'linked';
  /** Explicit native appearance commands; omitted flags retain existing styling/visibility. */
  appearance?: {
    id: string;
    emphasized?: boolean;
    descriptionVisible?: boolean;
    imageVisible?: boolean;
  }[];
  /** Linked updates are explicit and keep the same declared native roles. */
  definition?: TemplateDefinition;
  requestId?: string;
}
function bodyInputs(content: NativeContent, current: ReturnType<typeof readStructure>, id: string) {
  const d = current.definition,
    repeat = d.repeats[d.structure!.repeat],
    parts = reusableParts(content);
  const values: Record<string, InputValue> = {
    ...clone((d.sample[repeat.slot] as Record<string, InputValue>[])[0]),
    [d.structure!.itemId]: id,
  };
  for (const binding of repeat.bindings) {
    const prototype = repeat.prototype[Number(binding.path[0])] as { id: string };
    const actual = parts.get(current.instance.parts[itemPart(id, prototype.id)]);
    const path = binding.path
      .slice(1)
      .map((key) => (typeof key === 'string' ? (current.instance.nativeIds?.[key] ?? key) : key));
    const owner = at(actual, path.slice(0, -1));
    const value =
      binding.mode === 'text' && path.at(-1) === 'text' && record(owner)
        ? reusablePartText(owner)
        : at(actual, path);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      values[binding.slot] = value;
  }
  return values;
}
function documentActions(state: Snapshot<NativeContent>, next: NativeContent): Action[] {
  if (!isDocument(state.content) || !isDocument(next)) return [];
  const tr = new Transform(contentToNode(state.content)),
    wanted = contentToNode(next);
  const position = (index: number) => {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += tr.doc.child(i).nodeSize;
    return pos;
  };
  const wantedIds = new Set(next.blocks.map((b) => b.id));
  for (let i = tr.doc.childCount - 1; i >= 0; i--)
    if (!wantedIds.has(tr.doc.child(i).attrs.id)) tr.delete(position(i), position(i + 1));
  for (let i = 0; i < wanted.childCount; i++) {
    const node = wanted.child(i);
    if (i < tr.doc.childCount && tr.doc.child(i).attrs.id === node.attrs.id) continue;
    let found = -1;
    tr.doc.forEach((old, _pos, index) => {
      if (old.attrs.id === node.attrs.id) found = index;
    });
    if (found >= 0) tr.delete(position(found), position(found + 1));
    tr.insert(position(i), node);
  }
  return tr.steps.length
    ? [
        {
          type: 'document.steps',
          target: 'text',
          payload: { version: state.engineVersion, steps: tr.steps.map((s) => s.toJSON()) },
        },
      ]
    : [];
}
export async function prepareStructureChange(options: StructureChange) {
  options = ownReuseOptions(options);
  const { state, identity, instanceId } = options,
    content = state.content,
    current = readStructure(content, instanceId);
  const d = await validateDefinition(options.definition ?? current.definition),
    s = d.structure;
  const oldS = current.definition.structure!;
  if (
    !s ||
    d.domain !== state.domain ||
    d.templateId !== current.definition.templateId ||
    (options.definition &&
      (current.relationship !== 'linked' ||
        d.templateVersion <= current.definition.templateVersion)) ||
    canonicalJson(d.repeats[s.repeat].prototype.map((p) => (p as { id: string }).id)) !==
      canonicalJson(
        current.definition.repeats[oldS.repeat].prototype.map((p) => (p as { id: string }).id),
      ) ||
    canonicalJson(d.repeats[s.repeat].path) !==
      canonicalJson(current.definition.repeats[oldS.repeat].path) ||
    s.anchor !== oldS.anchor ||
    s.itemId !== oldS.itemId ||
    s.flowRole !== oldS.flowRole ||
    canonicalJson(s.appearance ?? null) !== canonicalJson(oldS.appearance ?? null)
  )
    problem(
      'structure-update',
      '構成の役割が変わっています。別の挿入として確認し、必要な内容を移してください。',
      instanceId,
    );
  if (options.relationship && !['copy', 'linked'].includes(options.relationship))
    problem('structure-update', 'コピーまたはリンクを選んでください。', instanceId);
  for (const item of options.items)
    if (current.items.some((old) => old.id === item.id)) {
      const key = Object.keys(item).find((key) => key !== 'id');
      if (key)
        problem(
          'native-edit-required',
          '既存項目の本文・画像・型はnative編集APIで変更し、再配置にはIDのみを渡してください。',
          `items.${item.id}.${key}`,
        );
    } else {
      const fields =
        d.inputs.find((f) => f.key === d.repeats[s.repeat].slot)?.item?.fields?.map((f) => f.key) ??
        [];
      const unknown = Object.keys(item).find((key) => !fields.includes(key));
      if (unknown)
        problem(
          'invalid-input',
          'この項目の定義にない入力です。native編集APIを使ってください。',
          `items.${item.id}.${unknown}`,
        );
    }
  const temporaryNames = new Set([
    ...(d.content && 'columns' in d.content ? d.content.columns.map((c) => c.name) : []),
    ...options.items.map((item) => String(item.title ?? '')),
  ]);
  let nameSequence = 0;
  const placementInputs = (id: string) => {
    const value: Record<string, InputValue> = {
      ...clone((d.sample[d.repeats[s.repeat].slot] as Record<string, InputValue>[])[0]),
      id,
    };
    if (d.domain === 'data') {
      let name: string;
      do {
        name = `既存列の配置用${++nameSequence}`;
      } while (temporaryNames.has(name));
      temporaryNames.add(name);
      value.title = name;
    }
    return value;
  };
  const values: Record<string, InputValue> = {
    ...clone(d.sample),
    [s.layoutSlot]: options.layout ?? current.layout,
    [d.repeats[s.repeat].slot]: options.items.map((item) =>
      current.items.some((i) => i.id === item.id) ? placementInputs(item.id) : clone(item),
    ),
  };
  structureItems(d, values);
  const fresh = expandTemplate(d, values, { remap: false }).content!;
  const generated = readStructure(fresh, 'structure'),
    ids = new Map<string, string>(Object.entries(current.instance.nativeIds ?? {}));
  ids.set('structure', instanceId);
  for (const [key, id] of Object.entries(generated.instance.parts))
    if (current.instance.parts[key]) ids.set(id, current.instance.parts[key]);
  if (
    'components' in fresh &&
    d.content &&
    'components' in d.content &&
    current.definition.content &&
    'components' in current.definition.content &&
    canonicalJson(d.content.components) !== canonicalJson(current.definition.content.components)
  ) {
    // Keep existing cards bound to their existing definitions. Fork the entire source
    // component graph so nested dependencies also use this explicit publication.
    // Child IDs stay stable within each component scope, preserving old overrides/addresses.
    for (const component of fresh.components) ids.delete(component.id);
  }
  const mapped = remapNative(
    fresh,
    ids,
    `structure_${options.requestId ?? crypto.randomUUID()}`,
  ).content;
  const candidate = readStructure(mapped, instanceId),
    next = clone(content);
  if ('components' in mapped && 'components' in next)
    next.components.push(
      ...clone(mapped.components.filter((c) => !next.components.some((old) => old.id === c.id))),
    );
  const parts = reusableParts(next),
    freshParts = reusableParts(mapped);
  const desired = new Set(options.items.map((item) => item.id));
  const removed = current.items.filter((item) => !desired.has(item.id)),
    removedIds = new Set(removed.flatMap((item) => item.nativeIds));
  const oldOwned = new Set(Object.values(current.instance.parts));
  const documentExtras = new Map<string, string[]>();
  if (isDocument(content)) {
    const labels = new Map(
      current.items.map((i) => [current.instance.parts[itemPart(i.id, oldS.labelRole)], i.id]),
    );
    const headings = content.blocks.filter((b) => labels.has(b.id));
    if (headings.every((b) => b.type === 'heading' && b.level === headings[0].level)) {
      let owner: string | undefined;
      const first = content.blocks.findIndex((b) => labels.has(b.id));
      let last = first;
      content.blocks.forEach((block, index) => {
        if (labels.has(block.id)) last = index;
      });
      for (const [index, block] of content.blocks.entries()) {
        if (labels.has(block.id)) owner = labels.get(block.id);
        else if (block.type === 'heading' && (block.level ?? 1) <= (headings[0].level ?? 1)) {
          if (index > first && index < last)
            problem(
              'structure-reference',
              '項目の間に別の見出しがあります。本文構造を整えるか、構成の管理を解除してください。',
              block.id,
            );
          owner = undefined;
        }
        const owned = current.items.find((i) => i.nativeIds.includes(block.id));
        if (owned && owned.id !== owner)
          problem(
            'structure-reference',
            '見出しと本文の対応が変わっています。native本文を確認してください。',
            block.id,
          );
        if (owner && !oldOwned.has(block.id)) {
          const ids = documentExtras.get(owner) ?? [];
          ids.push(block.id);
          documentExtras.set(owner, ids);
        }
      }
      for (const item of removed)
        for (const id of documentExtras.get(item.id) ?? []) {
          if (
            content.reuse?.instances.some(
              (i) => i.id !== instanceId && Object.values(i.parts).includes(id),
            )
          )
            problem(
              'structure-reference',
              '別の再利用部品が管理する本文です。先に参照を変更してください。',
              id,
            );
          removedIds.add(id);
        }
    }
  }
  for (const [id, part] of parts)
    if (
      !removedIds.has(id) &&
      !(
        oldOwned.has(id) &&
        Object.keys(current.instance.parts).some(
          (key) => key.startsWith('edge.') && current.instance.parts[key] === id,
        )
      )
    )
      for (const key of ['parentId', 'groupId', 'sectionId', 'from', 'to'])
        if (typeof part[key] === 'string' && removedIds.has(part[key] as string))
          problem(
            'structure-reference',
            `${id}: 削除対象を参照しています。先に接続・所属を変更してください。`,
            id,
          );
  if (isStructuredData(next)) {
    for (const id of removedIds) {
      const key = Object.keys(current.instance.parts).find(
        (key) => current.instance.parts[key] === id,
      )!;
      if (current.instance.overrides[key]?.schema)
        problem(
          'structure-reference',
          '対応付けた既存列は削除できません。構成をコピーして別列へ挿入してください。',
          id,
        );
      if (next.views?.some((view) => JSON.stringify(view).includes(JSON.stringify(id))))
        problem(
          'structure-reference',
          '保存済みビューが参照する列です。先にビューの対応を変更してください。',
          id,
        );
      try {
        Object.assign(next, removeColumn(id).apply(next));
      } catch (e) {
        problem('structure-reference', (e as Error).message, id);
      }
    }
  }
  const originId = s.anchor && current.instance.parts[`anchor.${s.anchor}`];
  const origin = (originId && parts.get(originId)?.bounds) as { x: number; y: number } | undefined;
  const freshOrigin = (s.anchor &&
    freshParts.get(candidate.instance.parts[`anchor.${s.anchor}`])?.bounds) as
    | { x: number; y: number }
    | undefined;
  const path = structurePath(next, current.instance, current.definition),
    records = at(next, path) as {
      id: string;
      bounds?: { x: number; y: number; width: number; height: number };
    }[];
  const wanted = at(mapped, structurePath(mapped, candidate.instance, d)) as typeof records;
  const itemOwned = new Set(
    Object.entries(current.instance.parts)
      .filter(([key]) => key.startsWith('item.'))
      .map(([, id]) => id),
  );
  const existingRecords = new Map(records.map((r) => [r.id, r]));
  const changed = wanted
    .filter((r) =>
      Object.entries(candidate.instance.parts).some(
        ([key, id]) => key.startsWith('item.') && r.id === id,
      ),
    )
    .map((newRecord) => {
      const key = Object.keys(candidate.instance.parts).find(
        (key) => candidate.instance.parts[key] === newRecord.id,
      )!;
      const old = existingRecords.get(newRecord.id),
        result = old ? clone(old) : clone(newRecord);
      if (result.bounds && newRecord.bounds) {
        const baseline = current.instance.overrides[key]?.automaticBounds;
        const b = record(baseline) ? baseline : undefined;
        result.bounds = {
          ...newRecord.bounds,
          x:
            newRecord.bounds.x -
            (freshOrigin?.x ?? 0) +
            (origin?.x ?? 0) +
            (old && b ? old.bounds!.x - (origin?.x ?? 0) - Number(b.x) : 0),
          y:
            newRecord.bounds.y -
            (freshOrigin?.y ?? 0) +
            (origin?.y ?? 0) +
            (old && b ? old.bounds!.y - (origin?.y ?? 0) - Number(b.y) : 0),
          width: newRecord.bounds.width + (old && b ? old.bounds!.width - Number(b.width) : 0),
          height: newRecord.bounds.height + (old && b ? old.bounds!.height - Number(b.height) : 0),
        };
      }
      return result;
    });
  for (const ids of documentExtras.values()) for (const id of ids) itemOwned.add(id);
  const grouped =
    isDocument(content) && documentExtras.size
      ? options.items.flatMap((item) => {
          const old = current.items.find((i) => i.id === item.id);
          if (!old)
            return changed.filter((r) =>
              Object.entries(candidate.instance.parts).some(
                ([key, id]) => key.startsWith(`item.${item.id}.`) && id === r.id,
              ),
            );
          const ids = new Set([...old.nativeIds, ...(documentExtras.get(item.id) ?? [])]);
          return records
            .filter((r) => ids.has(r.id))
            .map((r) => changed.find((c) => c.id === r.id) ?? r);
        })
      : changed;
  const first = records.findIndex((r) => itemOwned.has(r.id)),
    untouched = records.filter((r) => !itemOwned.has(r.id)),
    insertion =
      first < 0
        ? untouched.length
        : records.slice(0, first).filter((r) => !itemOwned.has(r.id)).length;
  setAt(next, path, [...untouched.slice(0, insertion), ...grouped, ...untouched.slice(insertion)]);
  // Container extents grow with content; preserve an explicitly enlarged container.
  if (originId && origin && 'bounds' in parts.get(originId)!) {
    const root = parts.get(originId)!,
      freshRoot = freshParts.get(candidate.instance.parts[`anchor.${s.anchor}`])!;
    if (record(root.bounds) && record(freshRoot.bounds))
      for (const key of ['width', 'height'])
        root.bounds[key] = Math.max(Number(root.bounds[key]), Number(freshRoot.bounds[key]));
  }
  const connectionNotices: string[] = [];
  if ('connectors' in next && 'connectors' in mapped) {
    const oldEdges = new Set(
      Object.entries(current.instance.parts)
        .filter(([key]) => key.startsWith('edge.'))
        .map(([, id]) => id),
    );
    const surviving = next.connectors.filter((edge) => {
      const remove =
        oldEdges.has(edge.id) && (removedIds.has(edge.from) || removedIds.has(edge.to));
      if (remove) connectionNotices.push(`削除する接続: ${edge.label || edge.id} (${edge.id})`);
      return !remove;
    });
    const newNative = new Set(changed.filter((r) => !existingRecords.has(r.id)).map((r) => r.id));
    const additions = mapped.connectors.filter(
      (edge) =>
        !surviving.some((old) => old.from === edge.from && old.to === edge.to) &&
        (newNative.has(edge.from) || newNative.has(edge.to) || removed.length > 0),
    );
    next.connectors = [...surviving, ...additions];
    // A visual reorder preserves the actual graph, labels, ports and connector IDs.
    for (const key of Object.keys(candidate.instance.parts).filter((key) =>
      key.startsWith('edge.'),
    )) {
      if (!next.connectors.some((edge) => edge.id === candidate.instance.parts[key]))
        delete candidate.instance.parts[key];
    }
    for (const [key, id] of Object.entries(current.instance.parts))
      if (key.startsWith('edge.') && next.connectors.some((edge) => edge.id === id))
        candidate.instance.parts[key] = id;
    connectionNotices.push(
      '既存の接続・ラベル・ポートは保持します。並べ替えは配置に適用し、接続先はWhiteboard上で編集できます。',
    );
  }
  if (isStructuredData(next))
    for (const row of next.rows)
      for (const field of next.columns)
        if (field.type !== 'formula' && !(field.id in row.values))
          row.values[field.id] = field.defaultValue ?? null;
  const instance = clone(candidate.instance);
  instance.inputs.relationship = options.relationship ?? current.relationship;
  // Geometry baselines are relative; native schema ownership and other explicit overrides survive.
  for (const key of Object.keys(instance.parts))
    instance.overrides[key] = { ...current.instance.overrides[key], ...instance.overrides[key] };
  const closure = candidate.closure;
  if ('reuse' in next && next.reuse) {
    next.reuse.instances = next.reuse.instances.map((i) => (i.id === instanceId ? instance : i));
    if (!next.reuse.closures.some((c) => c.hash === closure.hash))
      next.reuse.closures.push(clone(closure));
    next.reuse.closures = next.reuse.closures.filter((c) =>
      next.reuse!.instances.some((i) => i.closureHash === c.hash),
    );
  }
  if (options.appearance?.length) {
    const targets = s.appearance;
    if (
      !targets ||
      options.appearance.length > s.max ||
      new Set(options.appearance.map((a) => a.id)).size !== options.appearance.length
    )
      problem('structure-appearance', 'この構成の表示対象を指定してください。', instanceId);
    const actual = readStructure(next, instanceId);
    for (const item of options.appearance) {
      if (
        !desired.has(item.id) ||
        Object.entries(item).some(
          ([key, value]) =>
            key !== 'id' &&
            (!['emphasized', 'descriptionVisible', 'imageVisible'].includes(key) ||
              typeof value !== 'boolean'),
        )
      )
        problem('structure-appearance', '表示対象・設定値が無効です。', `appearance.${item.id}`);
      if (item.emphasized !== undefined)
        patchReusablePart(next, structureAppearanceAddress(actual, item.id, targets.emphasis), {
          typography: { bold: item.emphasized },
        });
      if (item.descriptionVisible !== undefined)
        patchReusablePart(next, structureAppearanceAddress(actual, item.id, targets.description), {
          hidden: !item.descriptionVisible,
        });
      if (item.imageVisible !== undefined)
        patchReusablePart(next, structureAppearanceAddress(actual, item.id, targets.image), {
          hidden: !item.imageVisible,
        });
    }
  }
  assertNative(d.domain, next);
  const diagnostics = layoutDiagnostics(d, next);
  if (diagnostics.some((d) => d.severity === 'error'))
    throw new TemplateError(
      'overflow',
      '収まりません。縦・自動配置や別ページへの分割を選び、個別調整を確認してください。',
      diagnostics,
    );
  const actions = isDocument(content)
    ? documentActions(state, next)
    : reusableNativeActions(
        state,
        identity,
        ('reuse' in content ? { ...next, reuse: content.reuse } : next) as NativeContent,
      );
  actions.push({
    type: 'reuse.instance',
    target: instanceId,
    payload: { value: instance, closure },
  });
  return prepareNativeApplication({
    state,
    identity,
    id: options.requestId ?? crypto.randomUUID(),
    definition: d,
    summary: `${d.name}の構成を変更`,
    actions,
    reads: [
      reuseInstanceKey(instanceId),
      ...(isDocument(content) &&
      (removed.length ||
        canonicalJson(current.items.map((i) => i.id)) !==
          canonicalJson(
            options.items
              .filter((i) => current.items.some((old) => old.id === i.id))
              .map((i) => i.id),
          ))
        ? ['text']
        : []),
    ],
    insertedIds: changed.filter((r) => !existingRecords.has(r.id)).map((r) => r.id),
    notices: [
      ...connectionNotices,
      ...(options.definition
        ? [
            `原本 v${current.definition.templateVersion} → v${d.templateVersion}。既存の本文・画像・書式を保持し、配置と今後の追加項目に反映します。`,
          ]
        : []),
      ...removed.map((item) => `削除: ${item.label} (${item.id}) / ${item.nativeIds.join(', ')}`),
      ...removed.flatMap((item) =>
        (documentExtras.get(item.id) ?? []).map((id) => `削除する見出し内の追加本文・画像: ${id}`),
      ),
    ],
  });
}
/** A new immutable catalog version. Storage remains the existing CatalogAdapter.put boundary. */
export async function createStructureVersion(
  old: TemplateDefinition,
  changes: Partial<
    Pick<
      TemplateDefinition,
      'name' | 'description' | 'purpose' | 'content' | 'repeats' | 'structure' | 'sample'
    >
  >,
  nextVersion = old.templateVersion + 1,
) {
  if (!old.structure) problem('structure-schema', '可変構成の原本を指定してください。');
  if (!Number.isInteger(nextVersion) || nextVersion <= old.templateVersion)
    problem('version-conflict', '新しい公開版は採用中の版より後の番号を指定してください。');
  await validateDefinition(old);
  return validateDefinition(
    await sealDefinition({
      ...clone(old),
      ...clone(changes),
      templateVersion: nextVersion,
    }),
  );
}
/** Capture edited native appearances and sample bodies into a NEW recipe version. */
export async function captureStructureVersion(
  content: NativeContent,
  instanceId: string,
  nextVersion?: number,
) {
  const current = readStructure(content, instanceId),
    old = current.definition,
    d = clone(old),
    repeat = d.repeats[d.structure!.repeat],
    parts = reusableParts(content);
  const reverse = new Map(
    Object.entries(current.instance.nativeIds ?? {}).map(([source, target]) => [target, source]),
  );
  for (const [key, id] of Object.entries(current.instance.parts))
    if (key.startsWith('anchor.')) reverse.set(id, key.slice('anchor.'.length));
  const first = current.items[0];
  for (const proto of repeat.prototype as { id: string }[])
    reverse.set(current.instance.parts[itemPart(first.id, proto.id)], proto.id);
  const componentTargets = new Map(Object.entries(current.instance.nativeIds ?? {}));
  if ('components' in content && d.content && 'components' in d.content) {
    const sources = d.content.components,
      seen = new Set<string>();
    const captureComponent = (sourceId: string, nativeId: string) => {
      if (seen.has(sourceId)) return;
      seen.add(sourceId);
      componentTargets.set(sourceId, nativeId);
      reverse.set(nativeId, sourceId);
      const source = sources.find((c) => c.id === sourceId),
        actual = content.components.find((c) => c.id === nativeId);
      for (const child of source?.elements ?? []) {
        const native = actual?.elements?.find(
          (e) => e.id === current.instance.nativeIds?.[child.id],
        );
        if (child.componentId && native?.componentId)
          captureComponent(child.componentId, native.componentId);
      }
    };
    for (const proto of repeat.prototype as { id: string; componentId?: string }[]) {
      const actual = parts.get(current.instance.parts[itemPart(first.id, proto.id)]);
      if (proto.componentId && typeof actual?.componentId === 'string')
        captureComponent(proto.componentId, actual.componentId);
    }
  }
  const nativeOrigin =
    d.structure!.anchor &&
    parts.get(current.instance.parts[`anchor.${d.structure!.anchor}`])?.bounds;
  const sourceOrigin =
    d.structure!.anchor && reusableParts(old.content!).get(d.structure!.anchor)?.bounds;
  const normalize = (value: Record<string, unknown>) => {
    const actual = clone(value);
    if (record(actual.bounds) && record(nativeOrigin) && record(sourceOrigin)) {
      actual.bounds.x = Number(actual.bounds.x) - Number(nativeOrigin.x) + Number(sourceOrigin.x);
      actual.bounds.y = Number(actual.bounds.y) - Number(nativeOrigin.y) + Number(sourceOrigin.y);
    }
    return remapNative(actual, new Map(reverse)).content;
  };
  // Capture owned static fields, retaining the recipe's own child collections.
  for (const [key, id] of Object.entries(current.instance.parts)) {
    if (!key.startsWith('anchor.')) continue;
    const sourceId = key.slice('anchor.'.length),
      source = reusableParts(d.content!).get(sourceId),
      actual = parts.get(id);
    if (!source || !actual) continue;
    const patch = normalize(actual);
    delete patch.objects;
    delete patch.id;
    patchReusablePart(d.content!, sourceId, patch);
  }
  if ('components' in content && d.content && 'components' in d.content)
    d.content.components = d.content.components.map((source) => {
      const id = componentTargets.get(source.id),
        actual = content.components.find((c) => c.id === id);
      return actual ? remapNative(clone(actual), new Map(reverse)).content : source;
    });
  repeat.prototype = repeat.prototype.map((proto) => {
    const actual = clone(
      parts.get(current.instance.parts[itemPart(first.id, (proto as { id: string }).id)])!,
    );
    return normalize(actual);
  });
  d.sample = {
    ...d.sample,
    [repeat.slot]: current.items.map((i) => bodyInputs(content, current, i.id)),
    [d.structure!.layoutSlot]: current.layout,
  };
  return createStructureVersion(
    old,
    { content: d.content, repeats: d.repeats, sample: d.sample },
    nextVersion,
  );
}
/** Adoption stays unchanged. Allocate against the publication destination, including archived
 * sources; its immutable put boundary still rejects a concurrent different publication. */
export async function publishStructureVersion(
  content: NativeContent,
  instanceId: string,
  catalog: CatalogAdapter,
) {
  const owned = clone(content),
    adopted = readStructure(owned, instanceId).definition,
    published = (await catalog.list({ domain: adopted.domain, archived: true })).filter(
      (d) => d.templateId === adopted.templateId,
    ),
    nextVersion = Math.max(adopted.templateVersion, ...published.map((d) => d.templateVersion)) + 1,
    definition = await captureStructureVersion(owned, instanceId, nextVersion);
  await catalog.put(definition);
  return definition;
}
