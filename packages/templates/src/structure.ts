import { clone } from '@editor-platform/artifact-core';
import {
  definitionRef,
  lockClosureSync,
  record,
  reuseHash,
  type ReuseInstance,
  type ReusableDefinition,
} from '@editor-platform/reuse-core';
import { at, nativeIds } from './native';
import { reusableParts, reusablePartText } from './reuse-native';
import { fieldAt } from './inputs';
import {
  problem,
  type InputValue,
  type NativeContent,
  type StructureLayout,
  type RepeatBinding,
  type TemplateDefinition,
} from './types';

type StoredRecipe = Omit<TemplateDefinition, 'repeats'> & {
  repeats: (Omit<RepeatBinding, 'prototype'> & { records: unknown[] })[];
};
export type StructureDefinition = ReusableDefinition<{ variableTemplate: StoredRecipe }>;
/** Reuse JSON reserves the property name prototype; retain records without weakening that guard. */
export function decodeStructureRecipe(raw: unknown): TemplateDefinition {
  if (!record(raw) || !Array.isArray(raw.repeats))
    problem('structure-schema', 'Invalid retained variable recipe');
  return {
    ...clone(raw),
    repeats: raw.repeats.map((repeat) => {
      if (!record(repeat) || !Array.isArray(repeat.records))
        problem('structure-schema', 'Invalid retained repeat records');
      const { records, ...rest } = clone(repeat);
      return { ...rest, prototype: records };
    }),
  } as unknown as TemplateDefinition;
}
function encodeRecipe(d: TemplateDefinition): StoredRecipe {
  return {
    ...clone(d),
    repeats: d.repeats.map(({ prototype, ...repeat }) => ({
      ...clone(repeat),
      records: clone(prototype),
    })),
  };
}
export const itemPart = (item: string, role: string) => `item.${item}.${role}`;
const itemPattern = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
export function validateStructure(d: TemplateDefinition) {
  const s = d.structure;
  if (!s) return;
  const repeat = d.repeats[s.repeat],
    field = repeat && fieldAt(d.inputs, repeat.slot);
  const roles = repeat?.prototype.map((p) => (record(p) ? p.id : undefined)) ?? [];
  if (
    s.schemaVersion !== 1 ||
    !s.unit?.trim() ||
    d.composition ||
    d.kind === 'preset' ||
    !Number.isInteger(s.repeat) ||
    s.repeat !== 0 ||
    s.itemId !== 'id' ||
    d.repeats.length !== 1 ||
    repeat.chunkSize ||
    !repeat.append ||
    !field?.item?.fields?.some((f) => f.key === s.itemId && f.type === 'text' && f.required) ||
    !roles.length ||
    roles.some((r) => typeof r !== 'string' || !itemPattern.test(r)) ||
    new Set(roles).size !== roles.length ||
    !roles.includes(s.labelRole) ||
    !Number.isInteger(s.min) ||
    s.min < 1 ||
    !Number.isInteger(s.max) ||
    s.max < s.min ||
    s.max > 12 ||
    s.max > d.overflow.maxItems ||
    field.min !== s.min ||
    field.max !== s.max ||
    !Number.isInteger(s.columns) ||
    s.columns < 1 ||
    s.columns > s.max ||
    fieldAt(d.inputs, s.layoutSlot)?.type !== 'enum' ||
    (s.anchor && (!d.content || !reusableParts(d.content).has(s.anchor))) ||
    (s.flowRole && (d.domain !== 'whiteboard' || !roles.includes(s.flowRole)))
  )
    problem('structure-schema', 'Invalid bounded native composition', 'structure');
  const path = repeat.path;
  const supported =
    d.domain === 'slide'
      ? path.length === 3 &&
        path[0] === 'slides' &&
        Number.isInteger(path[1]) &&
        path[2] === 'objects'
      : path.length === 1 &&
        path[0] ===
          (
            {
              whiteboard: 'nodes',
              design: 'elements',
              document: 'blocks',
              data: 'columns',
            } as Record<string, string>
          )[d.domain];
  if (!supported)
    problem('structure-schema', 'Unsupported variable native collection', 'structure.repeat');
  if (s.appearance) {
    if (
      !['slide', 'whiteboard', 'design'].includes(d.domain) ||
      Object.keys(s.appearance).sort().join(',') !== 'description,emphasis,image'
    )
      problem('structure-schema', 'Invalid native appearance targets', 'structure.appearance');
    for (const target of Object.values(s.appearance)) {
      if (typeof target !== 'string') problem('structure-schema', 'Invalid appearance address');
      const [role, child, ...rest] = target.split('/');
      const proto = repeat.prototype.find((p) => record(p) && p.id === role);
      if (
        !record(proto) ||
        rest.length ||
        (child &&
          (d.domain !== 'design' ||
            !d.content ||
            !('components' in d.content) ||
            !d.content.components
              .find((c) => c.id === proto.componentId)
              ?.elements?.some((e) => e.id === child)))
      )
        problem(
          'structure-schema',
          'Appearance target is missing',
          `structure.appearance.${target}`,
        );
    }
  }
}
export function structureAppearanceAddress(
  current: ReturnType<typeof readStructure>,
  itemId: string,
  target: string,
) {
  const [role, child] = target.split('/'),
    root = current.instance.parts[itemPart(itemId, role)];
  if (!root) problem('structure-reference', 'Appearance item is missing', itemId);
  return child ? `${root}/${current.instance.nativeIds?.[child] ?? child}` : root;
}
/** Derived from native content, never retained as a second appearance authority. */
export function readStructureAppearance(content: NativeContent, instanceId: string) {
  const current = readStructure(content, instanceId),
    targets = current.definition.structure!.appearance,
    parts = reusableParts(content);
  return targets
    ? current.items.map((item) => {
        const title = parts.get(structureAppearanceAddress(current, item.id, targets.emphasis))!,
          body = parts.get(structureAppearanceAddress(current, item.id, targets.description))!,
          image = parts.get(structureAppearanceAddress(current, item.id, targets.image))!;
        if (!title || !body || !image)
          problem(
            'structure-reference',
            '表示対象の部品が削除されています。Undoまたは構成の管理解除を選んでください。',
            item.id,
          );
        return {
          id: item.id,
          emphasized: record(title.typography) && title.typography.bold === true,
          descriptionVisible: body.hidden !== true,
          imageVisible: image.hidden !== true,
        };
      })
    : [];
}
export function structureItems(d: TemplateDefinition, inputs: Record<string, InputValue>) {
  const s = d.structure!,
    repeat = d.repeats[s.repeat],
    raw = inputs[repeat.slot];
  if (!Array.isArray(raw) || raw.length < s.min || raw.length > s.max)
    problem(
      'structure-count',
      `${repeat.slot}: ${s.min}〜${s.max}件にしてください。別配置や分割も利用できます。`,
      repeat.slot,
    );
  const ids = raw.map((v, i) => {
    const id = record(v) && v[s.itemId];
    if (typeof id !== 'string' || !itemPattern.test(id))
      problem(
        'item-id',
        '項目には英字から始まる安定ID（40文字以内）を指定してください。',
        `${repeat.slot}.${i}.${s.itemId}`,
      );
    return id;
  });
  if (new Set(ids).size !== ids.length)
    problem(
      'item-id',
      '項目IDが重複しています。既存IDは再採番せず、新しい項目に別IDを指定してください。',
      repeat.slot,
    );
  const layout = inputs[s.layoutSlot];
  if (!['auto', 'horizontal', 'vertical'].includes(String(layout)))
    problem('structure-layout', '配置を選択してください。', s.layoutSlot);
  return {
    ids,
    columns:
      layout === 'horizontal'
        ? raw.length
        : layout === 'vertical'
          ? 1
          : Math.min(s.columns, raw.length),
    layout: layout as StructureLayout,
  };
}
export function structureClosure(d: TemplateDefinition) {
  const unsigned = {
    schemaVersion: 1 as const,
    libraryId: 'native-template-layouts',
    definitionId: d.templateId,
    version: d.templateVersion,
    kind: 'pattern' as const,
    domain: d.domain,
    name: d.name,
    dependencies: [],
    payload: { variableTemplate: encodeRecipe(d) },
  };
  const definition: StructureDefinition = { ...unsigned, hash: reuseHash(unsigned) };
  return lockClosureSync<unknown>([definitionRef(definition)], [definition]);
}
export function isStructureInstance(i: ReuseInstance) {
  return i.ref.libraryId === 'native-template-layouts';
}
export function retainStructure(
  d: TemplateDefinition,
  content: NativeContent,
  parts: Record<string, string>,
  inputs: Record<string, InputValue>,
) {
  if (!d.structure) return;
  if (
    !(
      'elements' in content ||
      'nodes' in content ||
      'slides' in content ||
      'blocks' in content ||
      'columns' in content
    )
  )
    return;
  if (d.structure.anchor && 'elements' in content) {
    const root = content.elements.find((e) => e.id === d.structure!.anchor)!;
    for (const e of content.elements.filter((e) => e.parentId === root.id)) {
      root.bounds.width = Math.max(
        root.bounds.width,
        e.bounds.x + e.bounds.width - root.bounds.x + 30,
      );
      root.bounds.height = Math.max(
        root.bounds.height,
        e.bounds.y + e.bounds.height - root.bounds.y + 30,
      );
    }
  }
  const shape = structureItems(d, inputs),
    closure = structureClosure(d),
    current = reusableParts(content);
  const origin = (d.structure.anchor ? current.get(d.structure.anchor)?.bounds : undefined) as
    | { x: number; y: number }
    | undefined;
  const instance: ReuseInstance = {
    id: 'structure',
    ref: clone(closure.roots[0]),
    closureHash: closure.hash,
    inputs: { layout: shape.layout, relationship: 'copy' },
    parts,
    overrides: {},
    slots: {},
    nativeIds: Object.fromEntries(nativeIds(d.content!).map((id) => [id, id])),
  };
  for (const [id] of current)
    if (nativeIds(d.content!).includes(id)) instance.parts[`anchor.${id}`] = id;
  for (const [key, id] of Object.entries(instance.parts)) {
    const bounds = current.get(id)?.bounds as
      | { x: number; y: number; width: number; height: number }
      | undefined;
    if (bounds)
      instance.overrides[key] = {
        automaticBounds: {
          ...bounds,
          x: bounds.x - (origin?.x ?? 0),
          y: bounds.y - (origin?.y ?? 0),
        },
      };
  }
  if (d.structure.flowRole && 'connectors' in content) {
    shape.ids.slice(1).forEach((id, n) => {
      const previous = shape.ids[n],
        key = `edge.${previous}.${id}`,
        edgeId = `flow_${previous}_${id}`;
      content.connectors.push({
        id: edgeId,
        from: parts[itemPart(previous, d.structure!.flowRole!)],
        to: parts[itemPart(id, d.structure!.flowRole!)],
        label: '',
        routing: 'elbow',
      });
      instance.parts[key] = edgeId;
    });
  }
  content.reuse = { schemaVersion: 1, closures: [clone(closure)], instances: [instance] };
}
export function retainedStructure(content: NativeContent, instanceId: string) {
  const reuse = 'reuse' in content ? content.reuse : undefined;
  const instance = reuse?.instances.find((i) => i.id === instanceId && isStructureInstance(i));
  const closure = reuse?.closures.find((c) => c.hash === instance?.closureHash);
  const d = closure?.definitions.find((d) => d.hash === instance?.ref.hash) as
    | StructureDefinition
    | undefined;
  if (!instance || !closure || !d?.payload.variableTemplate?.structure)
    problem('structure-schema', '構成の原本・対応が見つかりません。', instanceId);
  return { instance, closure, definition: decodeStructureRecipe(d.payload.variableTemplate) };
}
export function structurePath(
  content: NativeContent,
  instance: ReuseInstance,
  d: TemplateDefinition,
) {
  const path = clone(d.repeats[d.structure!.repeat].path);
  if (path[0] === 'slides' && 'slides' in content && d.content && 'slides' in d.content) {
    const sourcePage = d.content.slides[Number(path[1])].id;
    const index = content.slides.findIndex((p) => p.id === instance.parts[`anchor.${sourcePage}`]);
    if (index < 0)
      problem(
        'structure-missing',
        '要修復: 配置先のページが削除されています。構成の管理を解除して自由編集を続けられます。',
        instance.id,
      );
    path[1] = index;
  }
  return path;
}
/** Validate retained management data independently of freely edited native targets.
 * Missing targets are a repairable editing state, including in immutable past versions. */
export function validateStructureInstance(content: NativeContent, instanceId: string) {
  const retained = retainedStructure(content, instanceId),
    { instance, definition: d } = retained;
  const s = d.structure!;
  if (
    !['auto', 'horizontal', 'vertical'].includes(String(instance.inputs.layout)) ||
    !['copy', 'linked'].includes(String(instance.inputs.relationship)) ||
    Object.keys(instance.inputs).some((key) => !['layout', 'relationship'].includes(key))
  )
    problem('structure-schema', '構成の配置・原本との関係が不正です。', instanceId);
  const expected = new Set(
    Object.keys(instance.parts)
      .filter((k) => k.startsWith('item.'))
      .map((k) => k.split('.')[1]),
  );
  const roles = (d.repeats[s.repeat].prototype as { id: string }[]).map((p) => p.id);
  const anchors = d.content
    ? [...reusableParts(d.content).keys()].filter((id) => nativeIds(d.content!).includes(id))
    : [];
  if (
    expected.size < s.min ||
    expected.size > s.max ||
    [...expected].some(
      (id) => !itemPattern.test(id) || roles.some((role) => !instance.parts[itemPart(id, role)]),
    ) ||
    Object.keys(instance.parts)
      .filter((key) => key.startsWith('item.'))
      .some((key) => key.split('.').length !== 3 || !roles.includes(key.split('.')[2])) ||
    anchors.some((id) => !instance.parts[`anchor.${id}`])
  )
    problem('structure-schema', '項目数・安定ID・役割の対応が原本と一致しません。', instanceId);
  return { ...retained, expected };
}
export function readStructure(content: NativeContent, instanceId: string) {
  const { expected, ...retained } = validateStructureInstance(content, instanceId),
    { instance, definition: d } = retained,
    s = d.structure!;
  const records = at(content, structurePath(content, instance, d)) as { id: string }[];
  if (!Array.isArray(records))
    problem(
      'structure-missing',
      '要修復: 配置先が見つかりません。構成の管理を解除して自由編集を続けられます。',
      instanceId,
    );
  const parts = reusableParts(content),
    seen = new Set<string>(),
    items: { id: string; label: string; nativeIds: string[] }[] = [];
  for (const entry of records) {
    const key = Object.keys(instance.parts).find(
      (k) => k.startsWith('item.') && instance.parts[k] === entry.id,
    );
    if (!key) continue;
    const id = key.split('.')[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const label = parts.get(instance.parts[itemPart(id, d.structure!.labelRole)]);
    let labelText = label ? reusablePartText(label) || String(label.name ?? id) : id;
    if (label?.type === 'instance') {
      const binding = d.repeats[s.repeat].bindings.find(
        (b) =>
          (d.repeats[s.repeat].prototype[Number(b.path[0])] as { id: string }).id === s.labelRole &&
          b.path[1] === 'overrides' &&
          b.path.at(-1) === 'text',
      );
      const child = binding && instance.nativeIds?.[String(binding.path[2])];
      const nativeChild = child && parts.get(`${label.id}/${child}`);
      if (nativeChild) labelText = reusablePartText(nativeChild);
    }
    items.push({
      id,
      label: labelText,
      nativeIds: Object.entries(instance.parts)
        .filter(([key]) => key.startsWith(`item.${id}.`))
        .map(([, value]) => value),
    });
  }
  if (seen.size !== expected.size || Object.values(instance.parts).some((id) => !parts.has(id)))
    problem(
      'structure-missing',
      '要修復: 自由編集で構成の要素が削除されました。Undoで戻すか、構成の管理を解除して自由編集を続けてください。',
      instanceId,
    );
  return {
    ...retained,
    items,
    layout: instance.inputs.layout as StructureLayout,
    relationship: instance.inputs.relationship as 'copy' | 'linked',
  };
}
