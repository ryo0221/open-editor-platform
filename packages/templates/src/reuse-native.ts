import { clone } from '@editor-platform/artifact-core';
import {
  isDesign,
  applyDesignOverride,
  type DesignContent,
  type DesignElement,
} from '@editor-platform/design/model';
import { isDocument } from '@editor-platform/document/model';
import { isDeck } from '@editor-platform/slide/model';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import { isStructuredData } from '@editor-platform/structured-data/model';
import {
  rejectReuse,
  type JsonValue,
  type PublicProperty,
  type ResolvedStyle,
  type ComponentContract,
} from '@editor-platform/reuse-core';
import type { NativeContent } from './types';
type Part = Record<string, unknown> & { id: string };
const canvasRichMarks = ['bold', 'italic', 'underline', 'strike', 'color'];
export function reusablePartRich(part: Record<string, unknown>): JsonValue {
  if (Array.isArray(part.rich)) return clone(part.rich) as JsonValue;
  if (Array.isArray(part.runs))
    return part.runs.map((run) => ({ text: run.text, ...clone(run.style ?? {}) })) as JsonValue;
  return [{ text: String(part.text ?? '') }];
}
export function reusableRichLimitation(content: NativeContent, part: Record<string, unknown>) {
  return richLimitation(isDocument(content), part);
}
function richLimitation(document: boolean, part: Record<string, unknown>) {
  if (document || !Array.isArray(part.runs)) return undefined;
  const unsupported = new Set(
    part.runs.flatMap((run) =>
      Object.keys(run.style ?? {}).filter((key) => !canvasRichMarks.includes(key)),
    ),
  );
  return unsupported.size
    ? `この文字範囲には公開rich入力の対象外の書式（${[...unsupported].join(', ')}）があります。元のEditorで書式を整えてから公開してください。`
    : undefined;
}
export function reusablePartText(part: Record<string, unknown>): string {
  const rich = Array.isArray(part.rich)
    ? part.rich
    : Array.isArray(part.runs)
      ? part.runs
      : undefined;
  return rich ? rich.map((span: { text: string }) => span.text).join('') : String(part.text ?? '');
}
/** Addresses are transient domain lookups, never an alternate stored node model. */
export function reusableParts(content: NativeContent): Map<string, Part> {
  const result = new Map<string, Part>();
  const put = (id: string, value: object) => {
    if (result.size >= 20000) rejectReuse('expanded-limit', 'Native expansion exceeds 20000 parts');
    result.set(id, value as Part);
  };
  if (isDesign(content)) {
    const walk = (element: DesignElement, address: string, stack: string[]) => {
      put(address, element);
      if (element.type !== 'instance') return;
      const component = content.components.find((c) => c.id === element.componentId);
      if (!component)
        rejectReuse('component-missing', 'Native Design component is missing', {
          nativeId: address,
        });
      if (stack.includes(component.id) || stack.length >= 16)
        rejectReuse('component-cycle', 'Native Design nesting is cyclic or too deep', {
          nativeId: address,
        });
      for (const part of component.elements ?? [])
        walk(applyDesignOverride(part, element.overrides?.[part.id]), address + '/' + part.id, [
          ...stack,
          component.id,
        ]);
    };
    content.elements.forEach((e) => walk(e, e.id, []));
  } else if (isDocument(content)) content.blocks.forEach((b) => put(b.id, b));
  else if (isDeck(content))
    content.slides.forEach((p) => {
      put(p.id, p);
      p.objects.forEach((o) => put(o.id, o));
    });
  else if (isWhiteboard(content))
    [...content.nodes, ...content.connectors, ...(content.sections ?? [])].forEach((p) =>
      put(p.id, p),
    );
  else if (isStructuredData(content))
    [...content.columns, ...(content.views ?? [])].forEach((p) => put(p.id, p));
  if (result.size > 20000) rejectReuse('expanded-limit', 'Native expansion exceeds 20000 parts');
  return result;
}
function patchDesign(
  content: DesignContent,
  address: string,
  patch: Record<string, unknown>,
  override: boolean,
  replaceNested: boolean,
) {
  const [root, ...path] = address.split('/');
  let element = content.elements.find((e) => e.id === root);
  if (!element) rejectReuse('part-missing', 'Native Design root is missing', { nativeId: address });
  for (let index = 0; index < path.length; index++) {
    const id = path[index];
    const component = content.components.find((c) => c.id === element!.componentId);
    const part = component?.elements?.find((p) => p.id === id);
    if (!part) rejectReuse('part-missing', 'Native Design part is missing', { nativeId: address });
    if (override) {
      element.overrides ??= {};
      const value = element.overrides[id] ?? {};
      // Materialize only the nested override chain, retaining the existing component scope.
      element.overrides[id] = value;
      if (index === path.length - 1) {
        for (const [key, field] of Object.entries(patch))
          (value as Record<string, unknown>)[key] =
            !replaceNested &&
            ['typography', 'layout'].includes(key) &&
            field &&
            typeof field === 'object'
              ? { ...(value as Record<string, object>)[key], ...clone(field) }
              : clone(field);
        return;
      }
      Object.assign(value, {
        componentId: part.componentId,
        type: part.type,
        overrides: value.overrides ?? {},
      });
      element = value as DesignElement;
    } else element = part;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (element as unknown as Part)[key];
    else
      (element as unknown as Part)[key] =
        !replaceNested &&
        ['typography', 'layout'].includes(key) &&
        value &&
        typeof value === 'object'
          ? { ...((element as unknown as Part)[key] as object), ...clone(value) }
          : clone(value);
  }
}
export function patchReusablePart(
  content: NativeContent,
  address: string,
  patch: Record<string, unknown>,
  override = false,
  replaceNested = false,
) {
  if (isDesign(content)) {
    patchDesign(content, address, patch, override, replaceNested);
    return;
  }
  const part = reusableParts(content).get(address);
  if (!part) rejectReuse('part-missing', 'Native part is missing', { nativeId: address });
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete part[key];
    else
      part[key] =
        !replaceNested && key === 'typography' && value && typeof value === 'object'
          ? { ...(part[key] as object), ...clone(value) }
          : clone(value);
  }
}
export function clearReusableOverride(content: NativeContent, address: string, keys: string[]) {
  if (!isDesign(content)) return;
  const [root, ...path] = address.split('/');
  let element = content.elements.find((e) => e.id === root);
  for (let index = 0; index < path.length && element; index++) {
    const id = path[index],
      overridden = element.overrides?.[id];
    if (index === path.length - 1) {
      if (overridden) {
        for (const key of keys) {
          const [field, subfield] = key.split('.');
          const record = overridden as Record<string, unknown>;
          if (subfield && record[field] && typeof record[field] === 'object') {
            delete (record[field] as Record<string, unknown>)[subfield];
            if (!Object.keys(record[field] as object).length) delete record[field];
          } else delete record[field];
        }
        if (!Object.keys(overridden).length) delete element.overrides![id];
      }
    } else element = overridden as DesignElement | undefined;
  }
}
export function nativePropertyPatch(
  content: NativeContent,
  address: string,
  field: string,
  type: PublicProperty['type'],
  value: JsonValue,
): Record<string, unknown> {
  return nativePropertyPatchFor(createReusableNativeEditor(content), address, field, type, value);
}
type PropertyPatch = Record<string, unknown> | undefined;
const dataProjections = [
  'Grid',
  'Form',
  'Chart',
  'Kanban',
  'Dashboard',
  'Timeline',
  'Roadmap',
  'Summary',
];
const dataFormats = ['decimal', 'currency', 'percent', 'iso-date'];
const documentStyleKeys = [
  'color',
  'highlight',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'spaceBefore',
  'spaceAfter',
];
const isHexColor = (value: JsonValue) => /^#[a-f0-9]{6}$/i.test(String(value));
function nativePropertyPatchFor(
  editor: ReusableNativeEditor,
  address: string,
  field: string,
  type: PublicProperty['type'],
  value: JsonValue,
): Record<string, unknown> {
  const part = editor.get(address);
  if (!part)
    rejectReuse('part-missing', 'Public property targets a missing native part', {
      nativeId: address,
    });
  if (editor.domain === 'data') return dataPropertyPatch(part, address, field, type, value);
  if (editor.domain === 'whiteboard' && !part.kind)
    return boardContainerPropertyPatch(part, address, field, type, value);
  const patch =
    sharedPropertyPatch(editor.domain, part, address, field, type, value) ??
    (editor.domain === 'document'
      ? documentPropertyPatch(part, address, field, type, value)
      : canvasPropertyPatch(editor.domain, part, field, type, value));
  if (patch) return patch;
  rejectReuse('property-target', 'Unsupported typed native property target', {
    nativeId: address,
    path: field,
  });
}
/** Data views expose name/accent/projection; columns expose display decimals/format. */
function dataPropertyPatch(
  part: Part,
  address: string,
  field: string,
  type: PublicProperty['type'],
  value: JsonValue,
): Record<string, unknown> {
  const patch =
    'projection' in part
      ? dataViewPropertyPatch(field, type, value)
      : dataColumnPropertyPatch(field, type, value);
  if (patch) return patch;
  rejectReuse(
    'property-target',
    'Data schema, formulas and relations require migration, not style properties',
    { nativeId: address, path: field },
  );
}
function dataViewPropertyPatch(field: string, type: PublicProperty['type'], value: JsonValue) {
  if (field === 'name' && type === 'text' && String(value).trim()) return { name: value };
  if (field === 'accent' && type === 'text' && isHexColor(value)) return { accent: value };
  if (field === 'projection' && type === 'enum' && dataProjections.includes(String(value)))
    return { projection: value };
  return undefined;
}
function dataColumnPropertyPatch(field: string, type: PublicProperty['type'], value: JsonValue) {
  if (
    field === 'decimals' &&
    type === 'number' &&
    Number.isInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= 8
  )
    return { decimals: value };
  if (field === 'format' && type === 'enum' && dataFormats.includes(String(value)))
    return { format: value };
  return undefined;
}
/** Whiteboard connectors and Sections accept only their own label, color and routing fields. */
function boardContainerPropertyPatch(
  part: Part,
  address: string,
  field: string,
  type: PublicProperty['type'],
  value: JsonValue,
): Record<string, unknown> {
  const patch =
    boardConnectorPropertyPatch(part, field, type, value) ??
    boardSectionPropertyPatch(part, field, type, value);
  if (patch) return patch;
  rejectReuse('property-target', 'Unsupported connector or Section property', {
    nativeId: address,
    path: field,
  });
}
function boardConnectorPropertyPatch(
  part: Part,
  field: string,
  type: PublicProperty['type'],
  value: JsonValue,
): PropertyPatch {
  if (!('from' in part)) return undefined;
  if (field === 'label' && type === 'text') return { [field]: value ?? '' };
  if (field === 'stroke' && type === 'text' && isHexColor(value)) return { stroke: value };
  if (
    field === 'routing' &&
    type === 'enum' &&
    ['straight', 'elbow', 'curve'].includes(String(value))
  )
    return { routing: value };
  return undefined;
}
function boardSectionPropertyPatch(
  part: Part,
  field: string,
  type: PublicProperty['type'],
  value: JsonValue,
): PropertyPatch {
  if (!('title' in part)) return undefined;
  if (field === 'title' && type === 'text') return { [field]: value ?? '' };
  if (field === 'background' && type === 'text' && isHexColor(value)) return { background: value };
  return undefined;
}
/** Visibility, text, rich text and image source targets common to every rendered domain. */
function sharedPropertyPatch(
  domain: ReusableNativeEditor['domain'],
  part: Part,
  address: string,
  field: string,
  type: PublicProperty['type'],
  value: JsonValue,
): PropertyPatch {
  if (field === 'visible' && type === 'boolean') return { hidden: !value };
  if (field === 'hidden' && type === 'boolean') return { hidden: value };
  if (field === 'text' && type === 'text') return textPropertyPatch(domain, part, value);
  if (field === 'rich' && type === 'rich-text')
    return richPropertyPatch(domain, part, address, field, value);
  if (field === 'src' && type === 'asset' && (part.type === 'image' || part.kind === 'image'))
    return { src: value ?? (domain === 'design' ? '' : undefined) };
  return undefined;
}
function textPropertyPatch(domain: ReusableNativeEditor['domain'], part: Part, value: JsonValue) {
  return reusablePartText(part) === (value ?? '')
    ? { text: value ?? '' }
    : domain === 'document'
      ? { text: value ?? '', rich: [{ text: value ?? '' }] }
      : { text: value ?? '', runs: [{ text: value ?? '' }] };
}
function richPropertyPatch(
  domain: ReusableNativeEditor['domain'],
  part: Part,
  address: string,
  field: string,
  value: JsonValue,
) {
  const spans = (value ?? []) as { text: string; [key: string]: JsonValue }[];
  const limitation = richLimitation(domain === 'document', part);
  if (limitation) rejectReuse('rich-format', limitation, { nativeId: address, path: field });
  if (
    !(domain === 'document') &&
    spans.some((span) =>
      Object.keys(span).some((key) => key !== 'text' && !canvasRichMarks.includes(key)),
    )
  )
    rejectReuse(
      'rich-format',
      'This canvas supports bold, italic, underline, strike and color in public rich input',
      { nativeId: address, path: field },
    );
  return domain === 'document'
    ? { rich: clone(spans), text: spans.map((s) => s.text).join('') }
    : {
        runs: spans.map(({ text, ...style }) => ({ text, style })),
        text: spans.map((s) => s.text).join(''),
      };
}
/** Document paragraph/heading alignment, indent and inline style targets. */
function documentPropertyPatch(
  part: Part,
  address: string,
  field: string,
  type: PublicProperty['type'],
  value: JsonValue,
): PropertyPatch {
  if (!['paragraph', 'heading'].includes(String(part.type)))
    rejectReuse('property-target', 'Document attributes target paragraphs/headings only', {
      nativeId: address,
      path: field,
    });
  if (field === 'align' && type === 'enum') return { align: value };
  if (field === 'indent' && type === 'number') return { indent: value };
  if (field.startsWith('style.') && ['number', 'enum', 'text'].includes(type)) {
    const key = field.slice(6);
    if (!documentStyleKeys.includes(key))
      rejectReuse('property-target', 'Unsupported Document style target', { path: field });
    return { style: { ...((part.style as object) ?? {}), [key]: value } };
  }
  return undefined;
}
/** Canvas page background and color targets; geometry and typography follow. */
function canvasPropertyPatch(
  domain: ReusableNativeEditor['domain'],
  part: Part,
  field: string,
  type: PublicProperty['type'],
  value: JsonValue,
): PropertyPatch {
  if (
    domain === 'slide' &&
    field === 'background' &&
    !part.type &&
    type === 'text' &&
    isHexColor(value)
  )
    return { background: value };
  if (
    ['fill', 'stroke', 'color'].includes(field) &&
    ['text', 'enum'].includes(type) &&
    isHexColor(value)
  )
    return domain === 'whiteboard' && part.kind === 'text' && field === 'color'
      ? { color: value, typography: { ...(part.typography as object), color: value } }
      : { [field]: value };
  return canvasShapePropertyPatch(domain, part, field, type, value);
}
function canvasShapePropertyPatch(
  domain: ReusableNativeEditor['domain'],
  part: Part,
  field: string,
  type: PublicProperty['type'],
  value: JsonValue,
): PropertyPatch {
  if (['opacity', 'strokeWidth', 'radius'].includes(field) && type === 'number')
    return { [field]: value };
  if (field === 'typography.fontSize' && type === 'number')
    return { typography: { fontSize: value } };
  if (field === 'typography.align' && type === 'enum') return { typography: { align: value } };
  if (
    field === 'layout.gap' &&
    type === 'number' &&
    domain === 'design' &&
    part.type === 'frame' &&
    part.layout
  )
    return { layout: { gap: value } };
  return undefined;
}
type AddSuggestion = (
  field: string,
  label: string,
  type: PublicProperty['type'],
  value: JsonValue,
  extra?: Partial<PublicProperty>,
) => void;
/** Human authoring choices use the same finite native targets as headless properties. */
export function publicPropertySuggestions(
  content: NativeContent,
  part: ComponentContract['parts'][number],
): Omit<PublicProperty, 'id'>[] {
  const native = reusableParts(content).get(part.nativeId);
  if (!native) return [];
  const options: Omit<PublicProperty, 'id'>[] = [];
  const add: AddSuggestion = (field, label, type, value, extra = {}) =>
    options.push({ label, type, default: value, ...extra, targets: [{ partId: part.id, field }] });
  if (isStructuredData(content)) {
    addDataSuggestions(native, add);
    return options;
  }
  if (isWhiteboard(content) && !native.kind) {
    addBoardContainerSuggestions(native, add);
    return options;
  }
  const text = isTextPart(content, native);
  if (text) addTextSuggestions(content, native, add);
  addVisibilitySuggestions(content, native, text, add);
  addSurfaceSuggestions(content, native, add);
  return options;
}
function addDataSuggestions(native: Part, add: AddSuggestion) {
  if ('projection' in native) {
    add('name', 'ビュー名', 'text', native.name as JsonValue);
    add('accent', 'グラフの色', 'text', (native.accent as JsonValue) ?? '#5269c8');
    add('projection', '表示形式', 'enum', native.projection as JsonValue, {
      options: [...dataProjections],
    });
  } else if (['number', 'formula', 'date'].includes(String(native.type))) {
    add('decimals', '小数桁', 'number', (native.decimals as JsonValue) ?? 0, { min: 0, max: 8 });
    add('format', '数値・日付の表示', 'enum', (native.format as JsonValue) || 'decimal', {
      options: [...dataFormats],
    });
  }
}
function addBoardContainerSuggestions(native: Part, add: AddSuggestion) {
  if ('from' in native) {
    add('label', '接続のラベル', 'text', native.label as JsonValue);
    add('stroke', '線の色', 'text', (native.stroke as JsonValue) ?? '#5b7161');
    add('routing', '線の経路', 'enum', (native.routing as JsonValue) ?? 'straight', {
      options: ['straight', 'elbow', 'curve'],
    });
  } else {
    add('title', 'Section名', 'text', native.title as JsonValue);
    add('background', 'Section背景', 'text', native.background as JsonValue);
  }
}
function isTextPart(content: NativeContent, native: Part) {
  return isDocument(content)
    ? ['paragraph', 'heading'].includes(String(native.type))
    : isWhiteboard(content)
      ? !!native.kind && !['group', 'freehand'].includes(String(native.kind))
      : native.type === 'text';
}
function defaultFontSize(content: NativeContent, native: Part) {
  return isDocument(content)
    ? 12
    : isWhiteboard(content)
      ? native.kind === 'sticky'
        ? 22
        : 18
      : 28;
}
function addTextSuggestions(content: NativeContent, native: Part, add: AddSuggestion) {
  const document = isDocument(content);
  add('text', '文字', 'text', reusablePartText(native));
  if (!reusableRichLimitation(content, native))
    add('rich', '装飾付き文字', 'rich-text', reusablePartRich(native));
  const style = (document ? native.style : native.typography) as
    | Record<string, JsonValue>
    | undefined;
  add(
    document ? 'style.fontSize' : 'typography.fontSize',
    document ? '文字サイズ (pt)' : '文字サイズ (px)',
    'number',
    style?.fontSize ?? defaultFontSize(content, native),
    { min: 1, max: document ? 384 : 512 },
  );
  add(
    document ? 'align' : 'typography.align',
    '文字揃え',
    'enum',
    ((document ? native.align : style?.align) as JsonValue) ?? 'left',
    { options: ['left', 'center', 'right'] },
  );
  if (document) add('style.color', '文字色', 'text', style?.color ?? '#202d28');
}
function addVisibilitySuggestions(
  content: NativeContent,
  native: Part,
  text: boolean,
  add: AddSuggestion,
) {
  if (
    text ||
    isDesign(content) ||
    (isDeck(content) && native.type) ||
    (isWhiteboard(content) && native.kind)
  )
    add('visible', '表示', 'boolean', !native.hidden);
  if (native.type === 'image' || native.kind === 'image')
    add('src', '画像', 'asset', (native.src as JsonValue) || null);
}
function addSurfaceSuggestions(content: NativeContent, native: Part, add: AddSuggestion) {
  if (!isDocument(content) && !(isDeck(content) && !native.type)) {
    add(
      isWhiteboard(content) ? 'color' : 'fill',
      '塗り色',
      'text',
      ((isWhiteboard(content) ? native.color : native.fill) as JsonValue) ?? '#ffffff',
    );
    add('opacity', '不透明度', 'number', (native.opacity as JsonValue) ?? 1, { min: 0, max: 1 });
  }
  if (isDeck(content) && !native.type)
    add('background', 'ページ背景', 'text', native.background as JsonValue);
  if (isDesign(content) && native.type === 'frame' && native.layout)
    add('layout.gap', '子部品の間隔 (px)', 'number', (native.layout as { gap: number }).gap, {
      min: 0,
      max: 10000,
    });
}
export function materializePartStyle(
  content: NativeContent,
  address: string,
  resolved: ResolvedStyle,
  name: string,
) {
  return materializePartStyleFor(createReusableNativeEditor(content), address, resolved, name);
}
function materializePartStyleFor(
  editor: ReusableNativeEditor,
  address: string,
  resolved: ResolvedStyle,
  name: string,
) {
  const part = editor.get(address);
  if (!part)
    rejectReuse('part-missing', 'Style targets a missing native part', { nativeId: address });
  if (
    (editor.domain === 'design' && ['instance', 'group'].includes(String(part.type))) ||
    (editor.domain === 'slide' && (!part.type || part.type === 'group')) ||
    (editor.domain === 'whiteboard' &&
      (part.kind === 'group' ||
        (!part.kind &&
          (!('from' in part) ||
            Object.keys(resolved.properties).some(
              (key) => !['stroke', 'strokeWidth'].includes(key),
            )))))
  )
    rejectReuse(
      'style-target',
      'Assign this style to a rendered native child, not its component/group/page container',
      { nativeId: address },
    );
  const patch: Record<string, unknown> = {};
  const properties = Object.fromEntries(
    Object.entries(resolved.properties).map(([key, value]) => {
      if (key.endsWith('fontFamily') && Array.isArray(value)) {
        if (!value.length)
          rejectReuse('style-font', 'Font family requires a primary face', { path: key });
        return [key, value[0]];
      }
      if (key.endsWith('fontWeight') && ![400, 700].includes(Number(value)))
        rejectReuse('style-weight', 'This native adapter supports regular (400) and bold (700)', {
          path: key,
        });
      return [key, value];
    }),
  );
  if (editor.domain === 'data') {
    if (!('projection' in part) || Object.keys(properties).some((key) => key !== 'view.accent'))
      rejectReuse('style-target', 'Data style targets a native view accent only');
    patch.accent = properties['view.accent'];
  } else if (editor.domain === 'document') {
    patch.style = { ...(part.style as object), ...clone(properties) };
    patch.styleName = name;
  } else
    for (const [path, value] of Object.entries(properties)) {
      const [field, key] = path.split('.');
      if (key) {
        if (field === 'layout' && !part.layout)
          rejectReuse('style-target', 'Layout style requires a native layout frame', {
            nativeId: address,
            path,
          });
        const normalized = key === 'fontWeight' ? 'bold' : key;
        patch[field] ??= { ...((part[field] as object) ?? {}) };
        (patch[field] as Record<string, unknown>)[normalized] =
          key === 'fontWeight' ? Number(value) >= 700 : value;
      } else if (editor.domain === 'whiteboard' && field === 'color' && part.kind === 'text') {
        patch.color = value;
        patch.typography = {
          ...(part.typography as object),
          ...(patch.typography as object),
          color: value,
        };
      } else patch[field] = value;
    }
  editor.patch(address, patch);
}

interface ReusableNativeEditor {
  domain: 'design' | 'document' | 'slide' | 'whiteboard' | 'data';
  get(address: string): Part | undefined;
  patch(
    address: string,
    patch: Record<string, unknown>,
    override?: boolean,
    replaceNested?: boolean,
  ): void;
  property(
    address: string,
    field: string,
    type: PublicProperty['type'],
    value: JsonValue,
  ): Record<string, unknown>;
  style(address: string, resolved: ResolvedStyle, name: string): void;
}
/** Private, synchronous staging lookup. It never escapes preparation, never caches a
 * caller's mutable graph, and does not replace final native validation. Structure
 * changes must start a fresh lookup; only supported properties/styles use this one. */
export function createReusableNativeEditor(content: NativeContent): ReusableNativeEditor {
  const design = isDesign(content) ? content : undefined;
  const domain = design
    ? 'design'
    : isDocument(content)
      ? 'document'
      : isDeck(content)
        ? 'slide'
        : isWhiteboard(content)
          ? 'whiteboard'
          : isStructuredData(content)
            ? 'data'
            : undefined;
  if (!domain) rejectReuse('component-domain', 'Native adapter is not available');
  const parts = reusableParts(content);
  const roots = new Map(design?.elements.map((part) => [part.id, part]));
  const components = new Map(design?.components.map((component) => [component.id, component]));
  const editor: ReusableNativeEditor = {
    domain,
    get(address) {
      if (!design) return parts.get(address);
      const [root, ...path] = address.split('/');
      let part = roots.get(root);
      for (const id of path) {
        const child = components.get(part?.componentId ?? '')?.elements?.find((p) => p.id === id);
        if (!child) return undefined;
        part = applyDesignOverride(child, part?.overrides?.[id]);
      }
      return part as unknown as Part | undefined;
    },
    patch(address, patch, override = false, replaceNested = false) {
      if (design) return patchDesign(design, address, patch, override, replaceNested);
      const part = parts.get(address);
      if (!part) rejectReuse('part-missing', 'Native part is missing', { nativeId: address });
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete part[key];
        else
          part[key] =
            !replaceNested && key === 'typography' && value && typeof value === 'object'
              ? { ...(part[key] as object), ...clone(value) }
              : clone(value);
      }
    },
    property: (address, field, type, value) =>
      nativePropertyPatchFor(editor, address, field, type, value),
    style: (address, resolved, name) => materializePartStyleFor(editor, address, resolved, name),
  };
  return editor;
}
