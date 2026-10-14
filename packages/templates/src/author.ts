import { clone, contentHash, newId } from '@editor-platform/artifact-core';
import { isDeck } from '@editor-platform/slide/model';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import { isDesign } from '@editor-platform/design/model';
import { isDocument } from '@editor-platform/document/model';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { assertNative, at, setAt } from './native';
import { sealDefinition, validateDefinition } from './engine';
import { assertTemplateSize, templateLimits } from './limits';
import { reusableParts } from './reuse-native';
import { captureComposition, type CompositionCapture } from './reuse-composition-inputs';
import {
  problem,
  type Domain,
  type NativeContent,
  type Path,
  type TemplateDefinition,
  type InputField,
  type InputValue,
  type Binding,
} from './types';
export interface SlotCandidate {
  path: Path;
  label: string;
  type: 'text' | 'asset' | 'list';
  value: InputValue;
}
export function slotCandidates(content: NativeContent): SlotCandidate[] {
  const result: SlotCandidate[] = [];
  const walk = (v: unknown, path: Path) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, [...path, i]));
      return;
    }
    const r = v as Record<string, unknown>;
    if (typeof r.src === 'string')
      result.push({
        path: [...path, 'src'],
        label: String(r.alt ?? r.name ?? '画像'),
        type: 'asset',
        value: r.src,
      });
    if (Array.isArray(r.items) && typeof r.text === 'string')
      result.push({
        path: [...path, 'items'],
        label: String(r.text).slice(0, 40) || 'リスト',
        type: 'list',
        value: r.items.map((i) =>
          (i as { rich: { text: string }[] }).rich.map((s) => s.text).join(''),
        ),
      });
    else if (
      typeof r.text === 'string' &&
      r.text &&
      r.type !== 'image' &&
      r.type !== 'table' &&
      !['html', 'react-preview', 'mermaid', 'code'].includes(String(r.type))
    )
      result.push({
        path: [...path, 'text'],
        label: String(r.text).slice(0, 40),
        type: 'text',
        value: r.text,
      });
    for (const [key, value] of Object.entries(r))
      if (!['rich', 'items', 'runs', 'reuse'].includes(key)) walk(value, [...path, key]);
  };
  walk(content, []);
  return result;
}
export function selectTemplateContent(
  domain: Domain,
  source: NativeContent,
  ids?: string[],
): NativeContent {
  assertTemplateSize(source, templateLimits.expandedBytes);
  const d = clone(source);
  assertNative(domain, d);
  if (!ids?.length) return d;
  const adopted = 'reuse' in d ? d.reuse : undefined;
  if ('reuse' in d) delete d.reuse;
  const chosen = new Set(ids);
  if (domain === 'slide' && isDeck(d)) {
    for (const page of d.slides)
      for (let i = 0; i < page.objects.length; i++)
        for (const object of page.objects)
          if (object.groupId && chosen.has(object.groupId)) chosen.add(object.id);
    d.slides = d.slides
      .filter((p) => chosen.has(p.id) || p.objects.some((o) => chosen.has(o.id)))
      .map((p) => ({
        ...p,
        objects: chosen.has(p.id)
          ? p.objects
          : p.objects
              .filter((o) => chosen.has(o.id) || (!!o.groupId && chosen.has(o.groupId)))
              .map((o) => ({
                ...o,
                groupId: o.groupId && chosen.has(o.groupId) ? o.groupId : undefined,
              })),
      }));
  } else if (domain === 'whiteboard' && isWhiteboard(d)) {
    for (const n of d.nodes) if (n.sectionId && chosen.has(n.sectionId)) chosen.add(n.id);
    for (let i = 0; i < d.nodes.length; i++)
      for (const n of d.nodes) if (n.groupId && chosen.has(n.groupId)) chosen.add(n.id);
    d.nodes = d.nodes
      .filter((n) => chosen.has(n.id))
      .map((n) => ({
        ...n,
        groupId: n.groupId && chosen.has(n.groupId) ? n.groupId : undefined,
        sectionId: n.sectionId && chosen.has(n.sectionId) ? n.sectionId : undefined,
      }));
    d.sections = d.sections?.filter((s) => chosen.has(s.id));
    d.connectors = d.connectors.filter((c) => chosen.has(c.from) && chosen.has(c.to));
  } else if (domain === 'design' && isDesign(d)) {
    for (let i = 0; i < d.elements.length; i++)
      for (const e of d.elements) if (e.parentId && chosen.has(e.parentId)) chosen.add(e.id);
    d.elements = d.elements
      .filter((e) => chosen.has(e.id))
      .map((e) => ({
        ...e,
        parentId: e.parentId && chosen.has(e.parentId) ? e.parentId : undefined,
      }));
    const components = new Set(d.elements.flatMap((e) => (e.componentId ? [e.componentId] : [])));
    const visit = (id: string, stack: Set<string>) => {
      if (stack.has(id) || stack.size >= 16)
        problem('component-cycle', 'Cyclic or too deeply nested Design component');
      const component = d.components.find((c) => c.id === id);
      if (!component) problem('internal-reference', 'Missing nested Design component');
      const next = new Set([...stack, id]);
      for (const part of component.elements ?? [])
        if (part.componentId) {
          components.add(part.componentId);
          visit(part.componentId, next);
        }
    };
    for (const id of [...components]) visit(id, new Set());
    d.components = d.components.filter((c) => components.has(c.id));
    const elements = [...d.elements, ...d.components.flatMap((c) => c.elements ?? [])];
    d.styles = d.styles?.filter((s) => elements.some((e) => e.styleId === s.id));
  } else if (domain === 'document' && isDocument(d))
    d.blocks = d.blocks.filter((b) => chosen.has(b.id));
  else if (domain === 'data' && isStructuredData(d)) {
    d.columns = d.columns.filter((c) => chosen.has(c.id));
    d.rows = d.rows.map((r) => ({
      ...r,
      values: Object.fromEntries(Object.entries(r.values).filter(([id]) => chosen.has(id))),
    }));
    d.views = (d.views ?? []).filter((view) => chosen.has(view.id));
  }
  // Expand native groups/pages/Sections first, then retain only complete ownership.
  // Non-Design IDs can contain slashes and must be matched as whole identifiers.
  if (adopted) {
    const parts = reusableParts(d);
    adopted.instances = adopted.instances.filter((instance) =>
      [...Object.values(instance.parts), ...Object.values(instance.slots).flat()].every((id) =>
        parts.has(id),
      ),
    );
    const closures = new Set(adopted.instances.map((i) => i.closureHash));
    adopted.closures = adopted.closures.filter((c) => closures.has(c.hash));
    if (adopted.instances.length) Object.assign(d, { reuse: adopted });
  }
  assertNative(domain, d);
  return d;
}
export interface AuthoredSlot {
  path: Path;
  key: string;
  label: string;
  type: 'text' | 'asset' | 'list';
  defaultValue?: InputValue;
  example?: InputValue;
}
export async function saveAsTemplate(options: {
  domain: Domain;
  content: NativeContent;
  ids?: string[];
  name: string;
  purpose: string;
  category: string;
  slots: AuthoredSlot[];
  kind: 'whole' | 'fragment';
  templateId?: string;
  version?: number;
  composition?: CompositionCapture;
  overflow?: Partial<TemplateDefinition['overflow']>;
}): Promise<TemplateDefinition> {
  options = clone(options);
  if (['review', 'file'].includes(options.domain))
    problem('unsupported-template', 'Review/Viewer support view presets only');
  const content = selectTemplateContent(
    options.domain,
    options.content,
    options.kind === 'fragment' ? options.ids : undefined,
  );
  const authored = options.composition
    ? captureComposition(content, options.composition)
    : undefined;
  // Data patterns reuse field/view structure against destination records.
  // Whole templates create the captured records with independently remapped IDs.
  if (authored && options.kind === 'fragment' && isStructuredData(content)) content.rows = [];
  if (!authored && 'reuse' in content) delete content.reuse;
  const originalCandidates = slotCandidates(content);
  for (const slot of options.slots) {
    const candidate = originalCandidates.find(
      (c) => JSON.stringify(c.path) === JSON.stringify(slot.path),
    );
    if (!candidate) problem('invalid-binding', 'The chosen slot is outside the saved content');
    if (slot.type === 'asset' && slot.defaultValue !== undefined)
      setAt(content, slot.path, clone(slot.defaultValue));
    // The saved native prototype must match the reviewed sample, so replacing a
    // slot sample does not leave an invisible original case in text/rich/list data.
    const sample = slot.example ?? slot.defaultValue;
    if (sample !== undefined && candidate.type !== 'asset') {
      const owner = at(content, slot.path.slice(0, -1)) as Record<string, unknown>;
      if (candidate.type === 'list') {
        if (!Array.isArray(sample))
          problem('invalid-input', 'List sample must be an array', slot.key);
        setAt(
          content,
          slot.path,
          sample.map((text, i) => ({
            id: `sample_${slot.key}_${i}`,
            paragraphId: `sample_${slot.key}_p_${i}`,
            rich: [{ text: String(text) }],
          })),
        );
        owner.text = sample.join('\n');
      } else {
        setAt(content, slot.path, Array.isArray(sample) ? sample.join('\n') : String(sample));
        delete owner.rich;
        delete owner.runs;
      }
    }
  }
  const assets: TemplateDefinition['assets'] = [];
  const portable = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string' && v.startsWith('blob:'))
      problem('missing-asset', 'Temporary blob URLs cannot be saved. Choose a portable image.');
    if (typeof v === 'string' && /^data:image\//.test(v)) {
      if (v.length > templateLimits.assetCharacters)
        problem('template-limit', 'Portable image exceeds 8 MiB of encoded characters');
      const hash = await contentHash(v),
        id = `asset-${hash}`;
      if (!assets.some((a) => a.id === id))
        assets.push({ id, hash, data: v, mime: v.slice(5, v.indexOf(';')) });
      return `asset://${id}`;
    }
    if (Array.isArray(v)) return Promise.all(v.map(portable));
    if (v && typeof v === 'object') {
      if ('src' in v && typeof v.src === 'string' && /^https?:/.test(v.src))
        problem(
          'external-asset',
          'Choose a portable image snapshot or an image input with a local sample',
        );
      return Object.fromEntries(
        await Promise.all(
          Object.entries(v).map(async ([k, x]) => [
            k,
            k === 'reuse' ? clone(x) : await portable(x),
          ]),
        ),
      );
    }
    return v;
  };
  const native = (await portable(content)) as NativeContent;
  const candidates = slotCandidates(native);
  const inputs: InputField[] = [],
    bindings: Binding[] = [],
    sample: Record<string, InputValue> = {};
  for (const slot of options.slots) {
    const candidate = candidates.find((c) => JSON.stringify(c.path) === JSON.stringify(slot.path));
    if (!candidate) problem('invalid-binding', 'The chosen slot is outside the saved content');
    if (
      (candidate.type === 'asset' && slot.type !== 'asset') ||
      (candidate.type === 'list' && slot.type !== 'list')
    )
      problem('invalid-binding', 'Choose the native slot type');
    const rawValue =
      slot.defaultValue ??
      (slot.type === 'list' && typeof candidate.value === 'string'
        ? candidate.value.split('\n')
        : candidate.value);
    const value = (slot.type === 'asset' ? await portable(rawValue) : rawValue) as InputValue;
    const example = (
      slot.type === 'asset' ? await portable(slot.example ?? value) : (slot.example ?? value)
    ) as InputValue;
    const field: InputField = {
      key: slot.key,
      label: slot.label,
      description: `${slot.label}の差し替え`,
      type: slot.type,
      required: slot.type !== 'asset',
      default: value,
      example,
      maxLength: slot.type === 'asset' ? templateLimits.assetCharacters : 1000,
      ...(slot.type === 'list'
        ? {
            min: 0,
            max: 30,
            item: {
              key: 'item',
              label: '項目',
              description: '本文',
              type: 'text' as const,
              maxLength: 300,
            },
          }
        : {}),
    };
    inputs.push(field);
    sample[slot.key] = example;
    bindings.push({
      slot: slot.key,
      path: slot.path,
      mode: slot.type === 'asset' ? 'asset' : candidate.type === 'list' ? 'list' : 'text',
      optional: slot.type === 'asset',
    });
  }
  for (const field of authored?.inputs ?? []) {
    const portableField =
      field.type === 'asset'
        ? {
            ...field,
            default: (await portable(field.default)) as InputValue,
            example: (await portable(field.example)) as InputValue,
          }
        : field;
    inputs.push(portableField);
    if (portableField.example !== undefined) sample[portableField.key] = portableField.example;
  }
  const schema = options.content.schemaVersion;
  const definition = await sealDefinition({
    schemaVersion: 1,
    templateId: options.templateId ?? newId('personal'),
    templateVersion: options.version ?? 1,
    name: options.name,
    description: options.purpose,
    purpose: options.purpose,
    category: options.category,
    tags: ['personal', ...(authored ? [options.kind === 'whole' ? 'template' : 'pattern'] : [])],
    locales: ['ja', 'en'],
    domain: options.domain,
    kind: options.kind,
    artifactSchema: schema,
    capabilities: ['native-content', 'typed-inputs', 'repeat-layout', 'checked-apply'],
    targets: [options.kind === 'whole' ? 'new-artifact' : 'insertion-anchor'],
    content: native,
    ...(authored ? { composition: authored.composition } : {}),
    inputs,
    sample,
    bindings,
    repeats: [],
    assets,
    overflow: {
      policy:
        options.domain === 'document'
          ? 'reflow'
          : options.domain === 'design' || options.domain === 'whiteboard'
            ? 'expand'
            : 'error',
      maxItems: 40,
      minFontSize: 16,
      ...(options.domain === 'design' && options.overflow
        ? { textScope: 'instance' as const }
        : {}),
      ...options.overflow,
    },
    preview: {
      renderer: 'native',
      description: '保存範囲を確認してください。内容に残る個別情報の自動判定は行いません。',
    },
  });
  // Check the portable references as definition data; expansion resolves them before native validation.
  return validateDefinition(definition);
}
export function slotValue(content: NativeContent, path: Path) {
  return at(content, path);
}
