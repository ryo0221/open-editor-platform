import { validateStructure, structureItems, retainStructure, itemPart } from './structure';
import {
  layoutDrawingText,
  normalizedRuns,
  textLines,
  type Drawing,
  type TextStyle,
  type TextRun,
} from '@editor-platform/editor-core';
import { clone, contentHash } from '@editor-platform/artifact-core';
import { ReuseError } from '@editor-platform/reuse-core';
import {
  appearance,
  applyDesignOverride,
  designDrawingProjector,
  designInstanceElements,
  layoutDesign,
  isDesign,
  type DesignElement,
  type DesignContent,
} from '@editor-platform/design/model';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import { isDeck } from '@editor-platform/slide/model';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { at, setAt, remapNative, assertNative, migrateNative } from './native';
import { validateInputs, fieldAt, inputAt } from './inputs';
import { assertTemplateSize, templateLimits } from './limits';
import {
  validateComposition,
  applyCompositionInputs,
  projectCompositionMembers,
} from './reuse-composition-inputs';
import { validateReusableClosure } from './reuse-catalog';
import {
  capabilities,
  domains,
  problem,
  TemplateError,
  type TemplateDefinition,
  type Binding,
  type Diagnostic,
  type InputField,
  type NativeContent,
  type Domain,
  type InputValue,
} from './types';
const safeKey = /^[A-Za-z][A-Za-z0-9_-]*$/;
function validatePresetFields(domain: Domain, fields: Record<string, InputValue>) {
  const allowed: Record<Domain, string[]> = {
    slide: ['fill', 'fontSize'],
    design: ['fill', 'fontSize'],
    whiteboard: ['color', 'stroke'],
    document: ['color', 'margin'],
    data: ['format', 'decimals', 'chartType'],
    review: ['split', 'wrap', 'annotations'],
    file: ['fit', 'zoom', 'annotations'],
  };
  for (const [key, value] of Object.entries(fields)) {
    let valid = allowed[domain].includes(key);
    if (['fill', 'color', 'stroke'].includes(key))
      valid &&= typeof value === 'string' && /^#[a-fA-F0-9]{6}$/.test(value);
    if (['fontSize', 'margin', 'decimals'].includes(key))
      valid &&=
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= (key === 'fontSize' ? 12 : 0) &&
        value <= (key === 'decimals' ? 10 : key === 'margin' ? 200 : 144);
    if (['split', 'wrap', 'annotations'].includes(key)) valid &&= typeof value === 'boolean';
    if (key === 'fit') valid &&= ['page', 'width', 'actual'].includes(String(value));
    if (key === 'zoom')
      valid &&= typeof value === 'number' && Number.isFinite(value) && value >= 0.05 && value <= 4;
    if (key === 'format') valid &&= ['decimal', 'currency', 'percent'].includes(String(value));
    if (key === 'chartType') valid &&= ['bar', 'line', 'pie'].includes(String(value));
    if (!valid) problem('unsupported-preset', `Unsupported ${domain} setting: ${key}`, key);
  }
}
export async function sealDefinition(
  definition: Omit<TemplateDefinition, 'hash'>,
): Promise<TemplateDefinition> {
  assertTemplateSize(definition);
  const unsigned = clone(definition) as TemplateDefinition;
  delete (unsigned as Partial<TemplateDefinition>).hash;
  return { ...unsigned, hash: await contentHash(unsigned) };
}
export async function validateDefinition(raw: unknown): Promise<TemplateDefinition> {
  try {
    return await checkDefinition(raw);
  } catch (error) {
    if (error instanceof TemplateError) throw error;
    if (error instanceof ReuseError)
      throw new TemplateError(
        error.code ?? 'reuse-schema',
        error.message,
        error.diagnostics.map((d) => ({
          code: d.code,
          path: d.address.path ?? d.address.instanceId ?? d.address.definitionId ?? '',
          message: d.message,
          severity: 'error' as const,
        })),
      );
    problem('template-schema', 'Malformed template definition');
  }
}
async function checkDefinition(raw: unknown): Promise<TemplateDefinition> {
  assertTemplateSize(raw);
  if (!raw || typeof raw !== 'object') problem('template-schema', 'Expected a template definition');
  const d = raw as TemplateDefinition;
  if (
    d.schemaVersion !== 1 ||
    !domains.includes(d.domain) ||
    !['whole', 'fragment', 'preset'].includes(d.kind) ||
    !safeKey.test(d.templateId) ||
    !Number.isSafeInteger(d.templateVersion) ||
    d.templateVersion < 1
  )
    problem('template-schema', 'Unsupported template schema or identity');
  const schemas: Record<string, number[]> = {
    slide: [1, 2],
    whiteboard: [1, 2, 3],
    design: [1, 2],
    document: [1, 2],
    data: [1, 2],
    review: [1, 2],
    file: [1, 2],
  };
  if (!schemas[d.domain].includes(d.artifactSchema))
    problem('domain-schema', 'Unsupported artifact schema');
  for (const key of ['name', 'description', 'purpose', 'category'] as const)
    if (typeof d[key] !== 'string' || !d[key].trim()) problem('template-schema', `Missing ${key}`);
  for (const key of ['tags', 'locales', 'capabilities', 'targets'] as const)
    if (!Array.isArray(d[key]) || !d[key].every((v) => typeof v === 'string'))
      problem('template-schema', `Invalid ${key}`);
  if (d.capabilities.some((c) => !capabilities.includes(c)))
    problem('capability', 'Template requires unsupported capabilities');
  if (
    !Array.isArray(d.inputs) ||
    !Array.isArray(d.bindings) ||
    !Array.isArray(d.repeats) ||
    !Array.isArray(d.assets) ||
    !d.sample ||
    typeof d.sample !== 'object' ||
    !d.overflow ||
    !['reflow', 'paginate', 'expand', 'error'].includes(d.overflow.policy) ||
    !Number.isInteger(d.overflow.maxItems) ||
    d.overflow.maxItems < 1 ||
    d.overflow.maxItems > 100 ||
    !Number.isFinite(d.overflow.minFontSize) ||
    d.overflow.minFontSize < (d.domain === 'design' ? 10 : 12) ||
    (d.overflow.textScope !== undefined && d.overflow.textScope !== 'instance') ||
    d.preview?.renderer !== 'native'
  )
    problem('template-schema', 'Invalid binding, input or layout definition');
  const validateFields = (fields: InputField[]) => {
    const keys = new Set<string>();
    for (const f of fields) {
      if (
        !f ||
        !safeKey.test(f.key) ||
        keys.has(f.key) ||
        typeof f.label !== 'string' ||
        typeof f.description !== 'string' ||
        ![
          'text',
          'rich-text',
          'number',
          'boolean',
          'date',
          'enum',
          'asset',
          'url',
          'object',
          'list',
          'table',
          'chart',
        ].includes(f.type)
      )
        problem('input-schema', 'Invalid or duplicate slot');
      keys.add(f.key);
      if (f.fields && !Array.isArray(f.fields)) problem('input-schema', 'Invalid object fields');
      if (f.type === 'object' && !f.fields) problem('input-schema', 'Object requires fields');
      if (['table', 'chart'].includes(f.type) && !f.item)
        problem('input-schema', 'Table/chart requires an item schema');
      for (const key of ['min', 'max', 'maxLength'] as const)
        if (f[key] !== undefined && !Number.isFinite(f[key]))
          problem('input-schema', 'Input bounds must be finite');
      if ((f.min ?? -Infinity) > (f.max ?? Infinity) || (f.maxLength ?? 0) < 0)
        problem('input-schema', 'Invalid input bounds');
      if (f.fields) validateFields(f.fields);
      if (f.item) validateFields([f.item]);
      if (f.type === 'enum' && (!f.options?.length || f.options.some((v) => typeof v !== 'string')))
        problem('input-schema', 'Enum requires choices');
    }
  };
  validateFields(d.inputs);
  const { hash, ...unsigned } = d;
  if (hash !== (await contentHash(unsigned)))
    problem('hash-mismatch', 'Template hash does not match its immutable definition');
  const assetIds = new Set<string>();
  let assetCharacters = 0;
  for (const asset of d.assets) {
    if (typeof asset?.data !== 'string') problem('missing-asset', 'Invalid asset data');
    assetCharacters += asset.data.length;
    if (
      asset.data.length > templateLimits.assetCharacters ||
      assetCharacters > templateLimits.totalAssetCharacters
    )
      problem('template-limit', 'Portable images exceed the template asset budget');
    if (
      !safeKey.test(asset.id) ||
      assetIds.has(asset.id) ||
      !/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(asset.mime) ||
      !asset.data.startsWith(`data:${asset.mime};base64,`) ||
      asset.hash !== (await contentHash(asset.data))
    )
      problem('missing-asset', 'Invalid, duplicate or damaged asset');
    assetIds.add(asset.id);
  }
  if (d.kind === 'preset') {
    if (
      !d.preset ||
      !['selection', 'artifact', 'view'].includes(d.preset.scope) ||
      !d.preset.fields ||
      d.content
    )
      problem('template-schema', 'Preset must contain settings without native source content');
  } else {
    if (
      ['review', 'file'].includes(d.domain) ||
      !d.content ||
      d.content.schemaVersion !== d.artifactSchema
    )
      problem('domain-schema', 'Native content or artifact schema does not match');
  }
  const checkBindings = (
    bindings: Binding[],
    source: unknown,
    fields: InputField[],
    repeat = false,
  ) => {
    for (const b of bindings) {
      if (
        !b ||
        !Array.isArray(b.path) ||
        !b.path.length ||
        b.path.some(
          (k) =>
            !['string', 'number'].includes(typeof k) ||
            ['__proto__', 'constructor', 'prototype', 'reuse'].includes(String(k)),
        ) ||
        !['value', 'text', 'rich', 'list', 'table', 'chart', 'asset'].includes(b.mode) ||
        (!repeat && !fieldAt(fields, b.slot)) ||
        at(source, b.path) === undefined
      )
        problem('invalid-binding', `Invalid native binding: ${b?.slot ?? 'unknown'}`);
    }
  };
  checkBindings(d.bindings, d.content ?? d.preset, d.inputs);
  for (const repeat of d.repeats) {
    const f = fieldAt(d.inputs, repeat.slot);
    if (
      !f ||
      !['list', 'table'].includes(f.type) ||
      !Array.isArray(repeat.prototype) ||
      !Array.isArray(at(d.content, repeat.path)) ||
      !Array.isArray(repeat.bindings) ||
      (repeat.beforeId !== undefined &&
        !(at(d.content, repeat.path) as { id?: string }[]).some((v) => v.id === repeat.beforeId)) ||
      (repeat.columns !== undefined && (!Number.isInteger(repeat.columns) || repeat.columns < 1)) ||
      [repeat.stepX, repeat.stepY].some((v) => v !== undefined && !Number.isFinite(v)) ||
      (repeat.chunkSize !== undefined &&
        (!Number.isInteger(repeat.chunkSize) || repeat.chunkSize < 1))
    )
      problem('invalid-binding', 'Invalid repeat target');
    checkBindings(repeat.bindings, repeat.prototype, f.item?.fields ?? [], true);
    for (const b of repeat.bindings)
      if (b.slot !== '$' && !fieldAt(f.item?.fields ?? [], b.slot))
        problem('invalid-binding', 'Unknown repeat item slot');
  }
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('asset://') && !assetIds.has(v.slice(8)))
      problem('missing-asset', `Missing asset ${v}`);
    if (v && typeof v === 'object')
      Object.entries(v).forEach(([key, value]) => {
        if (key !== 'reuse') walk(value);
      });
  };
  walk(d.content);
  walk(d.repeats);
  validateComposition(d);
  validateStructure(d);
  if (d.content && 'reuse' in d.content)
    for (const closure of d.content.reuse?.closures ?? []) await validateReusableClosure(closure);
  expandTemplate(d, d.sample);
  return clone(d);
}
function applyBinding(
  root: unknown,
  b: Binding,
  inputs: unknown,
  assets: TemplateDefinition['assets'],
) {
  let value = inputAt(inputs, b.slot);
  if (value === undefined || value === null || value === '') {
    if (b.optional) {
      setAt(root, b.path, '');
      return;
    }
    if (value === undefined) problem('invalid-input', `Missing ${b.slot}`, b.slot);
  }
  if (b.mode === 'text')
    value = Array.isArray(value)
      ? value.map((v) => (typeof v === 'string' ? v : String(v))).join('\n')
      : String(value ?? '');
  if (b.mode === 'asset') {
    if (typeof value !== 'string') problem('invalid-input', 'Expected an asset', b.slot);
    if (value.startsWith('asset://'))
      value =
        assets.find((a) => a.id === String(value).slice(8))?.data ??
        problem('missing-asset', 'Asset not in manifest', b.slot);
  }
  if (b.mode === 'list') {
    if (!Array.isArray(value)) problem('invalid-input', 'Expected a list', b.slot);
    value = value.map((v, i) => ({
      id: `listitem_${i}`,
      paragraphId: `paragraph_${i}`,
      rich: [{ text: String(v) }],
    }));
    value = remapNative(value).content;
  }
  if (b.mode === 'chart') {
    if (!Array.isArray(value)) problem('invalid-input', 'Expected chart data', b.slot);
    value = {
      label: String((at(root, b.path) as { label?: string })?.label ?? '集計'),
      labels: value.map((v) => String((v as Record<string, unknown>).label)),
      values: value.map((v) => Number((v as Record<string, unknown>).value)),
      capturedAt: '2000-01-01T00:00:00.000Z',
      type: 'bar',
      legend: true,
    };
  }
  setAt(root, b.path, clone(value));
  const owner = at(root, b.path.slice(0, -1)) as Record<string, unknown>;
  if (b.mode === 'rich') owner.text = (value as { text: string }[]).map((s) => s.text).join('');
  if (b.mode === 'list')
    owner.text = (value as { rich: { text: string }[] }[])
      .map((v) => v.rich.map((s) => s.text).join(''))
      .join('\n');
  if (b.mode === 'text' && b.path.at(-1) === 'text') {
    for (const key of ['rich', 'runs']) {
      const spans = owner[key];
      if (Array.isArray(spans) && spans.map((span) => span.text).join('') !== value)
        delete owner[key];
    }
  }
}
function transformBounds(value: unknown, x: number, y: number) {
  if (!value || typeof value !== 'object') return;
  const r = value as Record<string, unknown>;
  if (r.bounds) {
    const b = r.bounds as { x: number; y: number };
    b.x += x;
    b.y += y;
  }
  Object.values(value).forEach((v) => transformBounds(v, x, y));
}
export function expandTemplate(
  d: TemplateDefinition,
  input: unknown,
  options: { includeSampleRows?: boolean; remap?: boolean; preserveEmptyAssets?: boolean } = {},
) {
  assertTemplateSize(input, templateLimits.expandedBytes);
  const validation = validateInputs(d.inputs, input);
  if (!validation.valid)
    throw new TemplateError(
      'invalid-input',
      'Correct the highlighted inputs',
      validation.diagnostics,
    );
  const inputs = validation.values;
  if (d.kind === 'preset') {
    const settings = clone(d.preset!);
    for (const b of d.bindings) applyBinding(settings, b, inputs, d.assets);
    validatePresetFields(d.domain, settings.fields);
    return { content: undefined, settings, inputs, diagnostics: [] as Diagnostic[] };
  }
  let content = clone(d.content!);
  // Legacy templates keep independent-copy semantics, including older snapshots
  // which accidentally captured optional reusable metadata.
  if (!d.composition && 'reuse' in content) delete content.reuse;
  const slots = new Map<string, string>();
  const textOwners = new Map<object, string>();
  const textSlots = new Map<string, string>();
  const bind = (root: unknown, binding: Binding, values: unknown, slot = binding.slot) => {
    const owner = at(root, binding.path.slice(0, -1)) as { id?: string };
    if (owner?.id) slots.set(owner.id, slot);
    if (owner && binding.path.at(-1) === 'text') textOwners.set(owner, slot);
    applyBinding(root, binding, values, d.assets);
    if (
      d.structure &&
      binding.mode === 'asset' &&
      binding.optional &&
      binding.path.at(-1) === 'src' &&
      at(root, binding.path) === ''
    ) {
      const image = at(root, binding.path.slice(0, -1)) as Record<string, unknown>;
      const instance = at(root, [binding.path[0]]) as { componentId?: string };
      const scopedImage =
        d.domain === 'design' &&
        binding.path[1] === 'overrides' &&
        d.content &&
        'components' in d.content &&
        d.content.components
          .find((c) => c.id === instance?.componentId)
          ?.elements?.some((e) => e.id === binding.path[2] && e.type === 'image');
      if (image && (image.type === 'image' || image.kind === 'image' || scopedImage))
        image.hidden = true;
    }
  };
  for (const b of d.bindings) bind(content, b, inputs);
  const structureParts: Record<string, string> = {};
  for (const [repeatIndex, repeat] of d.repeats.entries()) {
    const shape = d.structure?.repeat === repeatIndex ? structureItems(d, inputs) : undefined;
    const raw = inputAt(inputs, repeat.slot);
    if (!Array.isArray(raw)) problem('invalid-input', 'Expected repeat items', repeat.slot);
    if (raw.length > d.overflow.maxItems)
      problem('overflow', 'Too many repeated items', repeat.slot);
    const chunks: unknown[] = repeat.chunkSize
      ? Array.from({ length: Math.ceil(raw.length / repeat.chunkSize) }, (_, i) =>
          raw.slice(i * repeat.chunkSize!, (i + 1) * repeat.chunkSize!),
        )
      : raw;
    const records = chunks.flatMap((item, i) => {
      const mapped = remapNative(
        repeat.prototype,
        undefined,
        shape ? `repeat_${shape.ids[i]}` : undefined,
      );
      const copy = mapped.content;
      if (shape)
        for (const p of repeat.prototype as { id: string }[])
          structureParts[itemPart(shape.ids[i], p.id)] = mapped.ids.get(p.id)!;
      for (const b of repeat.bindings)
        bind(copy, b, item, shape ? `${repeat.slot}.${shape.ids[i]}.${b.slot}` : repeat.slot);
      transformBounds(
        copy,
        (i % (shape?.columns ?? repeat.columns ?? 1)) * (repeat.stepX ?? 0),
        Math.floor(i / (shape?.columns ?? repeat.columns ?? 1)) * (repeat.stepY ?? 0),
      );
      return copy;
    });
    const existing = at(content, repeat.path) as { id?: string }[];
    const before = repeat.beforeId ? existing.findIndex((v) => v.id === repeat.beforeId) : -1;
    setAt(
      content,
      repeat.path,
      before >= 0
        ? [...existing.slice(0, before), ...records, ...existing.slice(before)]
        : repeat.append
          ? [...existing, ...records]
          : records,
    );
  }
  const resolve = (v: unknown, path: (string | number)[] = []): unknown => {
    if (typeof v === 'string' && v.startsWith('asset://'))
      return (
        d.assets.find((a) => a.id === v.slice(8))?.data ??
        problem('missing-asset', 'Missing portable asset')
      );
    if (Array.isArray(v))
      return v
        .filter(
          (x) =>
            options.preserveEmptyAssets ||
            !!d.composition ||
            !!d.structure ||
            !(x && typeof x === 'object' && 'src' in x && x.src === ''),
        )
        .map((value, index) => resolve(value, [...path, index]));
    if (v && typeof v === 'object') {
      if (textOwners.has(v)) textSlots.set(JSON.stringify([...path, 'text']), textOwners.get(v)!);
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, k === 'reuse' ? clone(x) : resolve(x, [...path, k])]),
      );
    }
    return v;
  };
  content = resolve(content) as NativeContent;
  if (d.composition) applyCompositionInputs(content, d.composition, inputs, d.assets);
  if (d.composition) projectCompositionMembers(content, d.composition);
  if (d.domain === 'design' && isDesign(content)) {
    if (d.overflow.policy === 'expand') {
      if (d.overflow.textScope === 'instance') {
        content = layoutDesign(content);
        expandDesignInstanceText(content);
      } else
        for (const e of content.elements) {
          if (e.type === 'text') {
            const size = e.typography?.fontSize ?? 20;
            e.bounds.height = Math.max(
              e.bounds.height,
              textLines(e.text, e.bounds.width - 16, e.typography).length * size * 1.3 + 16,
            );
          }
        }
    }
    content = layoutDesign(content);
  }
  if (d.domain === 'whiteboard' && isWhiteboard(content) && d.overflow.policy === 'expand')
    for (const section of content.sections ?? []) {
      const nodes = content.nodes.filter((n) => n.sectionId === section.id);
      section.bounds.width = Math.max(
        section.bounds.width,
        ...nodes.map((n) => n.bounds.x + n.bounds.width - section.bounds.x + 30),
      );
      section.bounds.height = Math.max(
        section.bounds.height,
        ...nodes.map((n) => n.bounds.y + n.bounds.height - section.bounds.y + 30),
      );
    }
  if (d.domain === 'data' && isStructuredData(content) && options.includeSampleRows === false)
    content.rows = [];
  content = migrateNative(d.domain, content);
  retainStructure(d, content, structureParts, inputs);
  assertTemplateSize(content, templateLimits.expandedBytes);
  if (options.remap !== false) {
    const remapped = remapNative(content);
    for (const [old, id] of remapped.ids) if (slots.has(old)) slots.set(id, slots.get(old)!);
    const paths = [...textSlots];
    textSlots.clear();
    for (const [key, slot] of paths) {
      const path = JSON.parse(key) as (string | number)[];
      const mapped = path.map((part, index) =>
        path[index - 1] === 'overrides' && typeof part === 'string'
          ? (remapped.ids.get(part) ?? part)
          : part,
      );
      textSlots.set(JSON.stringify(mapped), slot);
    }
    content = remapped.content;
  }
  assertNative(d.domain, content);
  const diagnostics =
    isDesign(content) && d.overflow.textScope === 'instance'
      ? collectLayoutDiagnostics(d, content, (path) => textSlots.get(JSON.stringify(path)))
      : layoutDiagnostics(d, content).map((d) => ({ ...d, path: slots.get(d.path) ?? d.path }));
  if (diagnostics.some((x) => x.severity === 'error'))
    throw new TemplateError('overflow', 'Input does not fit this layout', diagnostics);
  return { content, settings: undefined, inputs, diagnostics };
}
/** Deterministic template preflight, in native pixels; this is not a font-metric measurement. */
export function measureTemplateTextFit(options: {
  text: string;
  bounds: { width: number; height: number };
  fontSize?: number;
  minFontSize?: number;
  typography?: TextStyle;
  runs?: TextRun[];
}) {
  const { text, bounds } = options;
  const fontSize = options.fontSize ?? options.typography?.fontSize ?? 20;
  const minFontSize = options.minFontSize ?? 16;
  if (
    typeof text !== 'string' ||
    ![bounds.width, bounds.height, fontSize, minFontSize].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    fontSize <= 0 ||
    minFontSize <= 0
  )
    problem('invalid-layout', 'Text fit requires positive finite dimensions and font sizes');
  const columns = Math.max(1, Math.floor((bounds.width - 16) / fontSize));
  const lineCount = text
    ? text
        .split('\n')
        .reduce(
          (sum, line) =>
            sum +
            Math.max(
              1,
              Math.ceil(
                [...line].reduce((n, c) => n + (c.codePointAt(0)! <= 255 ? 0.55 : 1), 0) / columns,
              ),
            ),
          0,
        )
    : 0;
  let requiredHeight = lineCount * fontSize * 1.3 + 8;
  if (text && (options.typography || options.runs)) {
    const layout = layoutDrawingText({
      id: 'template-text-fit',
      kind: 'text',
      text,
      fill: 'none',
      bounds: { x: 0, y: 0, ...bounds },
      typography: { ...options.typography, fontSize, overflow: 'clip' },
      runs: options.runs,
    });
    // Retain the conservative legacy estimate, and cover the actual runs and padding.
    requiredHeight = Math.max(requiredHeight, layout.totalHeight + 2 * layout.padding);
  }
  return {
    fontSize,
    minFontSize,
    columns,
    lineCount,
    requiredHeight,
    fits:
      !text ||
      (fontSize >= minFontSize &&
        // Match drawing normalization and its 8px run floor; stale/empty runs do not own text.
        normalizedRuns(text, options.runs).every(
          (run) => Math.max(8, run.style?.fontSize ?? fontSize) >= minFontSize,
        ) &&
        requiredHeight <= bounds.height),
  };
}

/** Grow only instance-owned overrides. Shared component definitions retain local geometry. */
function expandDesignInstanceText(content: DesignContent) {
  const components = new Map(content.components.map((c) => [c.id, c]));
  const visit = (
    raw: DesignElement,
    projected: DesignElement,
    write: (patch: Partial<DesignElement>) => void,
    scale: { x: number; y: number },
    stack: string[],
  ) => {
    if (projected.hidden) return;
    const component = raw.type === 'instance' ? components.get(raw.componentId ?? '') : undefined;
    if (component?.elements) {
      if (stack.includes(component.id) || stack.length >= 16)
        problem('component-cycle', 'Design template nesting is cyclic or too deep');
      let overrides = raw.overrides;
      let parts = designInstanceElements(content, projected);
      for (const [index, part] of component.elements.entries()) {
        const effective = applyDesignOverride(part, overrides?.[part.id]);
        const world = parts[index];
        visit(
          effective,
          world,
          (patch) => {
            overrides = { ...overrides, [part.id]: { ...overrides?.[part.id], ...patch } };
            // A size override can change the space allocated to later fill/hug siblings.
            parts = designInstanceElements(content, { ...projected, overrides });
          },
          {
            x: projected.bounds.width / component.width,
            y: projected.bounds.height / component.height,
          },
          [...stack, component.id],
        );
      }
      if (overrides !== raw.overrides) write({ overrides });
      return;
    }
    const element = appearance(content, projected);
    if (element.type !== 'text' || !element.text) return;
    const fit = measureTemplateTextFit({
      text: element.text,
      bounds: element.bounds,
      fontSize: element.typography?.fontSize ?? 28,
      typography: element.typography,
      runs: element.runs,
    });
    if (fit.requiredHeight > element.bounds.height) {
      let height = fit.requiredHeight / scale.y;
      // Round division upward when multiplying back would fall below the exact fit threshold.
      if (height * scale.y < fit.requiredHeight) height += Number.EPSILON * Math.max(1, height);
      const ownsSize = raw.sizing === 'hug' || raw.sizing === 'fill';
      write({
        bounds: {
          ...raw.bounds,
          width: ownsSize ? element.bounds.width / scale.x : raw.bounds.width,
          height,
        },
        ...(ownsSize ? { sizing: 'fixed' } : {}),
      });
    }
  };
  for (const element of content.elements)
    visit(element, element, (patch) => Object.assign(element, patch), { x: 1, y: 1 }, []);
}

/** Conservative line-area preflight in the same rotation/flip axes as SVG frame clipping. */
function textClippedByFrame(drawing: Drawing): boolean {
  if (!drawing.text || !drawing.clipBounds?.length) return false;
  const layout = layoutDrawingText(drawing);
  const b = drawing.bounds;
  const cx = b.x + b.width / 2,
    cy = b.y + b.height / 2;
  const angle = ((drawing.rotation ?? 0) * Math.PI) / 180;
  const corners = [b.x, b.x + b.width].flatMap((x) =>
    [layout.startY, layout.startY + layout.totalHeight].map((y) => {
      const dx = (x - cx) * (drawing.flipX ? -1 : 1);
      const dy = (y - cy) * (drawing.flipY ? -1 : 1);
      return {
        x: cx + dx * Math.cos(angle) - dy * Math.sin(angle),
        y: cy + dx * Math.sin(angle) + dy * Math.cos(angle),
      };
    }),
  );
  return drawing.clipBounds.some((clip) => {
    const angle = ((clip.rotation ?? 0) * Math.PI) / 180;
    const cx = clip.x + clip.width / 2,
      cy = clip.y + clip.height / 2;
    return corners.some((point) => {
      const dx = point.x - cx,
        dy = point.y - cy;
      const x = cx + dx * Math.cos(angle) + dy * Math.sin(angle);
      const y = cy - dx * Math.sin(angle) + dy * Math.cos(angle);
      const tolerance = 1e-6;
      return (
        x < clip.x - tolerance ||
        x > clip.x + clip.width + tolerance ||
        y < clip.y - tolerance ||
        y > clip.y + clip.height + tolerance
      );
    });
  });
}

export function layoutDiagnostics(d: TemplateDefinition, content: NativeContent): Diagnostic[] {
  return collectLayoutDiagnostics(d, content);
}
function collectLayoutDiagnostics(
  d: TemplateDefinition,
  content: NativeContent,
  designTextPath?: (path: readonly (string | number)[]) => string | undefined,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const designInstanceText = isDesign(content) && d.overflow.textScope === 'instance';
  const error = (path: string, message: string) =>
    diagnostics.push({ code: 'overflow', path, message, severity: 'error' });
  const walk = (v: unknown, recurse = true, path?: string) => {
    if (!v || typeof v !== 'object') return;
    const r = v as Record<string, unknown>;
    if (
      r.bounds &&
      typeof r.text === 'string' &&
      r.text &&
      r.type !== 'group' &&
      r.kind !== 'group' &&
      r.type !== 'frame'
    ) {
      const b = r.bounds as { width: number; height: number };
      const t = (r.typography ?? {}) as { fontSize?: number; lineHeight?: number };
      if (
        !measureTemplateTextFit({
          text: r.text,
          bounds: b,
          fontSize: t.fontSize,
          minFontSize: d.overflow.minFontSize,
          ...(designInstanceText
            ? {
                typography: r.typography as TextStyle | undefined,
                runs: r.runs as TextRun[] | undefined,
              }
            : {}),
        }).fits
      )
        error(
          path ?? String(r.id),
          'Text exceeds the available box. Shorten the input or choose an expanding layout.',
        );
    }
    if (recurse)
      Object.entries(v).forEach(([key, value]) => {
        if (key !== 'reuse') walk(value);
      });
  };
  if (designInstanceText && isDesign(content)) {
    const project = designDrawingProjector(content);
    for (const element of content.elements)
      for (const drawing of project(element)) {
        const path = drawing.textSourcePath ? designTextPath?.(drawing.textSourcePath) : undefined;
        walk(drawing, false, path);
        if ((drawing.kind === 'text' || drawing.kind === 'shape') && textClippedByFrame(drawing))
          error(
            path ?? drawing.id,
            'Text is hidden by a clipping frame. Shorten the input or enlarge the frame.',
          );
      }
  } else walk(content);
  if (d.domain === 'slide' && isDeck(content))
    for (const page of content.slides)
      for (const o of page.objects)
        if (
          o.bounds.x < 0 ||
          o.bounds.y < 0 ||
          o.bounds.x + o.bounds.width > content.width + 1 ||
          o.bounds.y + o.bounds.height > content.height + 1
        )
          error(o.id, 'Object extends beyond the Slide page');
  return diagnostics;
}
