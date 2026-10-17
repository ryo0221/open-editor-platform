import { clone, newId } from '@editor-platform/artifact-core';
import { createComponent, isDesign } from '@editor-platform/design/model';
import { isDocument } from '@editor-platform/document/model';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { isDeck } from '@editor-platform/slide/model';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import {
  definitionRef,
  refKey,
  rejectReuse,
  resolveComponentProperties,
  resolveStyle,
  reuseHash,
  sealReusableDefinition,
  validateComponentContract,
  validateReusableDefinition,
  type ComponentContract,
  type DefinitionRef,
  type DomainStyle,
  type JsonValue,
  type LockedClosure,
  type ReusableDefinition,
  type TokenSet,
  type PublicProperty,
} from '@editor-platform/reuse-core';
import { saveAsTemplate, selectTemplateContent } from './author';
import { validateDefinition, expandTemplate } from './engine';
import { assertNative } from './native';
import { lockReusableRoot } from './reuse-dependencies';
import { createReusableNativeEditor, reusableParts, reusablePartText } from './reuse-native';
import type { Domain, NativeContent, TemplateDefinition } from './types';

export interface ReusablePayload {
  template: TemplateDefinition;
  contract: ComponentContract;
  /** Finite-page layout insertion and in-page objects are distinct native capabilities. */
  slide?: 'objects' | 'pages';
  data?: 'fields' | 'view';
  styles?: { partId: string; ref: DefinitionRef }[];
}
export interface ReusableStylePayload {
  style: DomainStyle;
  tokens: DefinitionRef;
}
export type ComponentDefinition = ReusableDefinition<ReusablePayload>;
/** Resolve immutable template-owned assets without changing any native IDs. */
export function reusablePrototype(d: ComponentDefinition): NativeContent {
  return expandTemplate(d.payload.template, d.payload.template.sample, {
    remap: false,
    preserveEmptyAssets: true,
  }).content!;
}
export function reusablePropertyValue(
  d: ComponentDefinition,
  property: PublicProperty,
  value: JsonValue,
): JsonValue {
  if (property.type !== 'asset' || typeof value !== 'string' || !value.startsWith('asset:'))
    return value;
  const id = value.replace(/^asset:(?:\/\/)?/, '');
  const asset = d.payload.template.assets.find((asset) => asset.id === id);
  if (!asset)
    rejectReuse('asset-missing', 'Public image input does not resolve to an owned asset', {
      path: property.id,
    });
  return asset.data;
}
export function closureDefinition<T>(
  closure: LockedClosure<unknown>,
  ref: DefinitionRef,
): ReusableDefinition<T> {
  const d = closure.definitions.find((d) => refKey(d) === refKey(ref));
  if (!d || d.hash !== ref.hash || d.kind !== ref.kind || d.domain !== ref.domain)
    rejectReuse('dependency-mismatch', 'Exact adopted definition is unavailable', {
      definitionId: ref.definitionId,
    });
  return d as ReusableDefinition<T>;
}
export function componentTokenModes(
  d: ComponentDefinition,
  closure: LockedClosure<unknown>,
): string[] {
  const sets = (d.payload.styles ?? []).map((binding) => {
    const style = closureDefinition<ReusableStylePayload>(closure, binding.ref);
    return closureDefinition<TokenSet>(closure, style.payload.tokens).payload.modes;
  });
  return sets[0]?.filter((mode) => sets.every((modes) => modes.includes(mode))) ?? [];
}
const validatedComponents = new WeakSet<ComponentDefinition>();
export async function validateComponentDefinition(raw: unknown): Promise<ComponentDefinition> {
  const d = await validateReusableDefinition<ReusablePayload>(raw);
  if (validatedComponents.has(d)) return d;
  if (
    !['component', 'pattern', 'template'].includes(d.kind) ||
    !d.payload?.template ||
    !d.payload.contract
  )
    rejectReuse('component-schema', 'Expected a native reusable component/pattern/template');
  const t = await validateDefinition(d.payload.template);
  if (t.domain !== d.domain || !t.content || !['fragment', 'whole'].includes(t.kind))
    rejectReuse('component-domain', 'Native prototype domain/kind differs from its definition');
  if ('reuse' in t.content && t.content.reuse)
    rejectReuse(
      'component-prototype',
      'Prototype must declare nesting as dependencies, without adopted instance history',
    );
  const contract = validateComponentContract(d.payload.contract),
    prototype = reusablePrototype(d),
    parts = reusableParts(prototype);
  if (isDeck(prototype)) {
    if (!['objects', 'pages'].includes(d.payload.slide ?? ''))
      rejectReuse('slide-capability', 'Choose in-page objects or whole-page layouts');
    if (
      d.payload.slide === 'objects' &&
      (prototype.slides.length !== 1 ||
        contract.parts.some((p) => p.nativeId === prototype.slides[0].id))
    )
      rejectReuse(
        'slide-capability',
        'In-page parts must use one page without owning its page settings',
      );
  } else if (d.payload.slide !== undefined)
    rejectReuse('slide-capability', 'Slide placement belongs to Slide definitions only');
  if (isStructuredData(prototype)) {
    if (!['fields', 'view'].includes(d.payload.data ?? '') || prototype.rows.length)
      rejectReuse(
        'data-capability',
        'Data reuse requires a field set or view without sample records',
      );
    if (contract.slots.length)
      rejectReuse(
        'data-capability',
        'Data uses explicit field/record bindings, not canvas or body slots',
      );
    if (
      d.payload.data === 'view' &&
      contract.parts.some((p) => prototype.columns.some((c) => c.id === p.nativeId))
    )
      rejectReuse('data-capability', 'View bindings cannot own the target schema');
  } else if (d.payload.data !== undefined)
    rejectReuse('data-capability', 'Data capability belongs to Data only');
  for (const part of contract.parts)
    if (!parts.has(part.nativeId))
      rejectReuse('part-missing', 'Stable part does not resolve in native prototype', {
        partId: part.id,
      });
  for (const binding of d.payload.styles ?? []) {
    if (
      !contract.parts.some((p) => p.id === binding.partId) ||
      binding.ref.kind !== 'style' ||
      binding.ref.domain !== d.domain ||
      !d.dependencies.some((r) => refKey(r) === refKey(binding.ref) && r.hash === binding.ref.hash)
    )
      rejectReuse('style-dependency', 'Style binding requires a declared native dependency', {
        partId: binding.partId,
      });
  }
  // Every variant must be valid at publication, not only the first selected one.
  for (const variant of [undefined, ...contract.variants.map((v) => v.id)]) {
    const value = clone(prototype),
      editor = createReusableNativeEditor(value),
      resolved = resolveComponentProperties(contract, {}, variant);
    for (const property of contract.properties)
      for (const target of property.targets) {
        const address = contract.parts.find((p) => p.id === target.partId)!.nativeId;
        editor.patch(
          address,
          editor.property(
            address,
            target.field,
            property.type,
            reusablePropertyValue(d, property, resolved.values[property.id]),
          ),
        );
      }
    assertNative(t.domain, value);
  }
  validatedComponents.add(d);
  return d;
}
/** Resolve tokens → named styles → variant → public inputs before native insertion/update. */
export async function materializeComponent(
  definition: ComponentDefinition,
  closure: LockedClosure<unknown>,
  inputs: Record<string, JsonValue> = {},
  variant?: string,
  mode?: string,
  artifactMode?: string,
) {
  const d = await validateComponentDefinition(definition);
  closureDefinition(closure, definitionRef(d));
  if (mode !== undefined && !componentTokenModes(d, closure).includes(mode))
    rejectReuse('token-mode', 'The selected component mode does not exist', { path: mode });
  const content = reusablePrototype(d),
    contract = d.payload.contract,
    editor = createReusableNativeEditor(content);
  for (const binding of d.payload.styles ?? []) {
    const style = closureDefinition<ReusableStylePayload>(closure, binding.ref);
    if (
      style.payload.style.domain !== d.domain ||
      !style.dependencies.some(
        (r) => refKey(r) === refKey(style.payload.tokens) && r.hash === style.payload.tokens.hash,
      )
    )
      rejectReuse('style-dependency', 'Style must declare its token dependency');
    const tokens = closureDefinition<TokenSet>(closure, style.payload.tokens);
    const resolved = resolveStyle(style.payload.style, tokens.payload, {
      ...(mode ? { instanceMode: mode } : {}),
      ...(artifactMode ? { artifactMode } : {}),
    });
    editor.style(
      contract.parts.find((p) => p.id === binding.partId)!.nativeId,
      resolved,
      style.name,
    );
  }
  const resolved = resolveComponentProperties(contract, inputs, variant);
  const defaults = resolveComponentProperties(contract, {}, variant);
  for (const property of contract.properties)
    for (const target of property.targets) {
      const address = contract.parts.find((p) => p.id === target.partId)!.nativeId;
      editor.patch(
        address,
        editor.property(
          address,
          target.field,
          property.type,
          reusablePropertyValue(d, property, defaults.values[property.id]),
        ),
      );
      if (resolved.explicit.includes(property.id))
        editor.patch(
          address,
          editor.property(
            address,
            target.field,
            property.type,
            reusablePropertyValue(d, property, resolved.values[property.id]),
          ),
          isDesign(content),
        );
    }
  assertNative(d.domain as Domain, content);
  return { content, resolved };
}
export function defaultComponentContract(content: NativeContent): ComponentContract {
  const parts = [...reusableParts(content)].map(([nativeId]) => ({
    id: 'part_' + reuseHash(nativeId).slice(0, 16),
    nativeId,
  }));
  const contract: ComponentContract = {
    schemaVersion: 1,
    parts,
    properties: [],
    slots: [],
    variants: [],
  };
  const native = reusableParts(content);
  for (const part of parts) {
    const p = native.get(part.nativeId)!;
    const textPart = isStructuredData(content)
      ? false
      : isDocument(content)
        ? ['paragraph', 'heading'].includes(String(p.type))
        : isWhiteboard(content)
          ? !!p.kind && !['group', 'freehand'].includes(String(p.kind))
          : p.type === 'text';
    if (textPart)
      contract.properties.push({
        id: 'text_' + part.id,
        label: (reusablePartText(p) || '本文').slice(0, 30),
        type: 'text',
        default: reusablePartText(p),
        targets: [{ partId: part.id, field: 'text' }],
      });
    if (
      (isDocument(content) && textPart) ||
      isDesign(content) ||
      (isDeck(content) && p.type) ||
      (isWhiteboard(content) && p.kind)
    )
      contract.properties.push({
        id: 'visible_' + part.id,
        label:
          p.type === 'instance' && !part.nativeId.includes('/')
            ? '部品全体を表示'
            : String(p.name ?? p.text ?? '部品').slice(0, 20) + 'を表示',
        type: 'boolean',
        default: !p.hidden,
        targets: [{ partId: part.id, field: 'visible' }],
      });
    if (isDocument(content) && textPart)
      contract.slots.push({
        id: 'body_' + part.id,
        partId: part.id,
        label: String(p.text || '本文').slice(0, 30),
        domain: 'document',
        accepts: ['body', 'component'],
        min: 0,
        max: 20,
      });
    if (isDesign(content) && p.type === 'frame')
      contract.slots.push({
        id: 'children_' + part.id,
        partId: part.id,
        label: String(p.name || '子部品'),
        domain: 'design',
        accepts: ['component'],
        min: 0,
        max: 20,
      });
    if (isDeck(content) && (p.type === 'group' || 'objects' in p))
      contract.slots.push({
        id: 'objects_' + part.id,
        partId: part.id,
        label: String(p.title ?? '子部品'),
        domain: 'slide',
        accepts: ['component'],
        min: 0,
        max: 20,
      });
    if (isWhiteboard(content) && (p.kind === 'group' || ('title' in p && !p.kind)))
      contract.slots.push({
        id: 'nodes_' + part.id,
        partId: part.id,
        label: String(p.title ?? p.name ?? '子部品'),
        domain: 'whiteboard',
        accepts: ['component'],
        min: 0,
        max: 20,
      });
  }
  contract.variants = [{ id: 'default', label: '標準', values: {} }];
  // Capture all native parts; only the automatically published controls are bounded.
  contract.properties = contract.properties.slice(0, 256);
  contract.slots = contract.slots.slice(0, 256);
  contract.defaultVariant = 'default';
  return contract;
}
export async function authorReusableComponent(options: {
  domain: Domain;
  content: NativeContent;
  ids: string[];
  slideSelection?: { pageId: string; elementId: string }[];
  name: string;
  libraryId?: string;
  definitionId?: string;
  version?: number;
  contract?: ComponentContract;
  slide?: 'objects' | 'pages';
  data?: 'fields' | 'view';
  styles?: ReusablePayload['styles'];
  dependencies?: ReusableDefinition<unknown>[];
  overflow?: Partial<TemplateDefinition['overflow']>;
}) {
  options = clone(options);
  if (!['design', 'document', 'slide', 'whiteboard', 'data'].includes(options.domain))
    rejectReuse('component-domain', 'This domain has no component authoring adapter');
  const data = options.domain === 'data' ? (options.data ?? 'fields') : undefined;
  const fieldIds = isStructuredData(options.content)
    ? options.ids.filter(
        (id) =>
          options.content &&
          isStructuredData(options.content) &&
          options.content.columns.some((c) => c.id === id),
      )
    : options.ids;
  let selected = selectTemplateContent(
    options.domain,
    options.content,
    data === 'view' ? [] : fieldIds,
    options.slideSelection,
  );
  if (isStructuredData(selected)) {
    selected.rows = [];
    if (data === 'view' && !selected.views?.length) selected.views = [defaultView(selected)];
  }
  if ('reuse' in selected) delete selected.reuse;
  if (
    isDesign(selected) &&
    [...selected.elements, ...selected.components.flatMap((c) => c.elements ?? [])].some((e) =>
      e.id.includes('/'),
    )
  )
    rejectReuse(
      'native-address',
      'Design reusable scopes reserve / between native IDs; create an ID-remapped copy before capturing these parts',
    );
  const slide = options.domain === 'slide' ? (options.slide ?? 'objects') : undefined;
  if (isDeck(selected) && slide === 'objects') {
    if (selected.slides.length !== 1 || !selected.slides[0].objects.length)
      rejectReuse('slide-selection', 'Select objects from one page for an in-page component');
    // Page notes/background are not part of an in-page component.
    const page = selected.slides[0];
    selected.slides = [{ id: page.id, title: '', background: '#ffffff', objects: page.objects }];
  }
  if (
    isDesign(selected) &&
    !(selected.elements.length === 1 && selected.elements[0].type === 'instance')
  ) {
    const original = clone(selected);
    selected = createComponent(selected.elements.filter((e) => !e.parentId).map((e) => e.id)).apply(
      selected,
    );
    if (isDesign(selected)) {
      const instance = selected.elements[0],
        component = selected.components.find((c) => c.id === instance.componentId)!;
      component.elements ??= original.elements.map((e) => ({
        ...e,
        bounds: {
          ...e.bounds,
          x: e.bounds.x - instance.bounds.x,
          y: e.bounds.y - instance.bounds.y,
        },
      }));
    }
  }
  const contract = options.contract ?? defaultComponentContract(selected);
  if (!options.contract && isDeck(selected) && slide === 'objects') {
    const pageIds = new Set(selected.slides.map((p) => p.id));
    contract.parts = contract.parts.filter((p) => !pageIds.has(p.nativeId));
    contract.slots = contract.slots.filter((s) => contract.parts.some((p) => p.id === s.partId));
  }
  if (!options.contract && isStructuredData(selected) && data === 'view')
    contract.parts = contract.parts.filter((p) => selected.views?.some((v) => v.id === p.nativeId));
  const template = await saveAsTemplate({
    domain: options.domain,
    content: selected,
    name: options.name,
    purpose: '版付きの再利用部品',
    category: '部品',
    slots: [],
    kind: 'fragment',
    overflow:
      options.domain === 'design'
        ? { textScope: 'instance', ...options.overflow }
        : options.overflow,
  });
  const d = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: options.libraryId ?? 'personal',
    definitionId: options.definitionId ?? newId('component'),
    version: options.version ?? 1,
    name: options.name,
    kind: 'component',
    domain: options.domain,
    dependencies: [
      ...new Map(
        (options.styles ?? []).map((binding) => [refKey(binding.ref), binding.ref]),
      ).values(),
    ],
    payload: {
      template,
      contract,
      ...(slide ? { slide } : {}),
      ...(data ? { data } : {}),
      ...(options.styles?.length ? { styles: options.styles } : {}),
    },
  });
  await validateComponentDefinition(d);
  const closure = await lockReusableRoot(d, options.dependencies);
  const modes = new Set<string | undefined>([undefined]);
  for (const binding of d.payload.styles ?? []) {
    const style = closureDefinition<ReusableStylePayload>(closure, binding.ref);
    const tokens = closureDefinition<TokenSet>(closure, style.payload.tokens);
    tokens.payload.modes.forEach((mode) => modes.add(mode));
  }
  if (d.payload.styles?.length)
    for (const mode of modes)
      for (const variant of [undefined, ...contract.variants.map((v) => v.id)])
        await materializeComponent(d, closure, {}, variant, mode);
  return {
    definition: d,
    closure,
    notices:
      !options.contract && (contract.properties.length === 256 || contract.slots.length === 256)
        ? [
            '自動で公開する入力・スロットは最大256項目です。すべての部品は保持します。必要な入力は公開フォームで選び直せます。',
          ]
        : [],
  };
}
