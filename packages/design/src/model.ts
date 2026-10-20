import {
  validEmbeddedReference,
  validReferenceItems,
  referenceLimitMessage,
  containsEmbeddedReference,
  describeReference,
  type EmbeddedReference,
} from '@editor-platform/artifact-references';
import {
  validDesignReactReference,
  validDesignWebData,
  validDesignWebElement,
  validDesignWebComponent,
  validDesignWebSettings,
  type DesignReactReference,
  type DesignWebElement,
  type DesignWebComponent,
  type DesignWebSettings,
} from './web-contract';
import {
  clone,
  canonicalJson,
  describeChanges,
  isDeepFrozen,
  newId,
  type CompareResult,
} from '@editor-platform/artifact-core';
import {
  command as nativeCommand,
  withCommandReads,
  drawingSvg,
  alignGeometry,
  distributeGeometry,
  transformGeometry,
  immutableCommand,
  descendantIds,
  selectedRoots,
  assertEditable,
  type VisualStyle,
  type Drawing,
  type Alignment,
  type TransformDelta,
  unionBounds,
  validBounds,
  validVisualStyle,
  validHierarchy,
  describeDrawing,
  describeVector,
  patchVisualStyle,
  matchingSizeBounds,
  reflectGeometry,
  reorderedSiblingIds,
  hierarchyPaintOrder,
  type Bounds,
  type EditorCommand,
  shapeNames,
} from '@editor-platform/editor-core';
import { validNativeReuse, record, type ReuseState } from '@editor-platform/reuse-core';
import { reactComponentKey } from '@editor-platform/react-ui-core';
import {
  remapDesignInteractionTargets,
  validDesignInteractions,
  validDesignPrototype,
  type DesignInteraction,
  type DesignPrototype,
} from './prototype-contract';
export * from './prototype-contract';
import { validDesignVector, type DesignVector } from './vector';
import { captureDesignData, designId, rejectDesign } from './command-data';
export { DesignCommandError } from './command-data';
export * from './vector';
export * from './intents';
export type DesignElementType =
  | 'frame'
  | 'rectangle'
  | 'text'
  | 'image'
  | 'group'
  | 'instance'
  | 'shape'
  | 'react';
export interface DesignElement extends VisualStyle {
  /** Reference source is canonical; src is a retained rendering cache. */
  reference?: EmbeddedReference;
  /** Colorable path geometry belongs to native Design shapes. */
  vector?: DesignVector;
  interactions?: DesignInteraction[];
  react?: DesignReactReference;
  web?: DesignWebElement;
  webSlots?: Record<string, string[]>;
  webProps?: Record<string, import('@editor-platform/react-ui-core').JsonValue>;
  id: string;
  type: DesignElementType;
  name: string;
  bounds: Bounds;
  text: string;
  fill: string;
  src?: string;
  parentId?: string;
  componentId?: string;
  overrides?: Record<string, Partial<DesignElement>>;
  styleId?: string;
  clipContent?: boolean;
  layout?: {
    direction: 'row' | 'column' | 'absolute';
    gap: number;
    padding: number;
    align: 'start' | 'center' | 'end';
    sizing: 'fixed' | 'hug';
  };
  sizing?: 'fixed' | 'hug' | 'fill';
  constraints?: {
    horizontal: 'left' | 'right' | 'center' | 'stretch' | 'scale';
    vertical: 'top' | 'bottom' | 'center' | 'stretch' | 'scale';
  };
}
export interface DesignComponent {
  web?: DesignWebComponent;
  id: string;
  name: string;
  elements?: DesignElement[];
  template: Pick<
    DesignElement,
    | 'type'
    | 'text'
    | 'fill'
    | 'src'
    | 'typography'
    | 'runs'
    | 'stroke'
    | 'strokeWidth'
    | 'opacity'
    | 'shape'
    | 'radius'
    | 'dash'
    | 'alt'
    | 'imageFit'
    | 'crop'
    | 'web'
    | 'interactions'
    | 'vector'
  >;
  width: number;
  height: number;
}
export interface DesignContent {
  prototyping?: DesignPrototype;
  web?: DesignWebSettings;
  schemaVersion: 1 | 2;
  reuse?: ReuseState;
  styles?: { id: string; name: string; appearance: Partial<VisualStyle> & { fill?: string } }[];
  elements: DesignElement[];
  components: DesignComponent[];
}
/** Projection-only native text location; never stored in Design content or SVG. */
export interface DesignDrawing extends Drawing {
  textSourcePath?: readonly (string | number)[];
  /** Instance-local text address, independent of drawing IDs and definition ownership. */
  instanceText?: { elementId: string; partIds: readonly string[]; name: string };
}
type DesignSourcePath = (string | number)[];
interface DesignDrawingSources {
  content: DesignContent;
  components: ReadonlyMap<string, DesignSourcePath>;
  owners: DesignSourcePath[];
  instance?: { elementId: string; partIds: string[] };
  locked?: boolean;
}
function designValueAt(
  content: DesignContent,
  path: DesignSourcePath,
): Partial<DesignElement> | undefined {
  return path.reduce<unknown>(
    (value, key) =>
      value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
    content,
  ) as Partial<DesignElement> | undefined;
}
export const createDesign = (): DesignContent => ({
  schemaVersion: 2,
  elements: [],
  components: [],
});
export function makeDesignElement(type: DesignElementType, index = 0): DesignElement {
  return defaultDesignElement(type, index, newId('design'));
}
function defaultDesignElement(type: DesignElementType, index: number, id: string): DesignElement {
  return {
    id,
    type,
    name: `${type[0].toUpperCase() + type.slice(1)} ${index + 1}`,
    bounds: {
      x: 60 + (index % 4) * 40,
      y: 60 + (index % 4) * 50,
      width: type === 'frame' ? 660 : type === 'text' ? 300 : 220,
      height: type === 'frame' ? 430 : type === 'text' ? 70 : 160,
    },
    text: type === 'text' ? 'Design with intention' : '',
    fill: type === 'frame' ? '#ffffff' : type === 'text' ? '#304a39' : '#d4e3cf',
  };
}
export interface DesignPlacement {
  id?: string;
  bounds?: Bounds;
  parentId?: string;
  /** Position in the native flat elements array, inclusive 0..length. */
  index?: number;
}
export interface DesignInsertOptions extends DesignPlacement {
  src?: string;
}
export interface DesignInsertionCommand extends EditorCommand<DesignContent> {
  readonly elementId: string;
}
function command(
  type: string,
  label: string,
  apply: (content: DesignContent) => DesignContent,
): EditorCommand<DesignContent> {
  return nativeCommand(type, label, (current) => {
    const next = apply(current);
    assertDesignContent(next);
    return next;
  });
}
/** Trusted Hosts may guard arbitrary commands and current access at execution. */
export function guardDesignCommand(
  value: EditorCommand<DesignContent>,
  writable: () => boolean = () => true,
): EditorCommand<DesignContent> {
  return {
    ...value,
    apply(current) {
      if (!writable()) rejectDesign('design-read-only', 'Design is read only');
      const next = value.apply(value.readonlyInput ? current : clone(current));
      assertDesignContent(next);
      return next;
    },
  };
}
export function assertDesignContent(value: unknown): asserts value is DesignContent {
  if (!isDesign(value)) {
    // isDesign also refuses an over-budget reference closure; report that limit first.
    const elements = (value as { elements?: unknown } | null)?.elements;
    if (Array.isArray(elements) && !validReferenceItems(elements))
      rejectDesign('design-content', referenceLimitMessage);
    rejectDesign('design-content', 'Command produced invalid Design content');
  }
  if (new Set(value.components.map((c) => c.id)).size !== value.components.length)
    rejectDesign('design-content', 'Duplicate Design component ID');
}
function targetElement(d: DesignContent, id: string): DesignElement {
  const e = d.elements.find((e) => e.id === id);
  if (!e) rejectDesign('design-target', 'Design element not found', id);
  return e;
}
function targetComponent(d: DesignContent, id: string): DesignComponent {
  const c = d.components.find((c) => c.id === id);
  if (!c) rejectDesign('design-target', 'Design component not found', id);
  return c;
}
const elementFields = new Set([
  'type',
  'name',
  'bounds',
  'text',
  'fill',
  'src',
  'parentId',
  'componentId',
  'overrides',
  'styleId',
  'clipContent',
  'layout',
  'sizing',
  'constraints',
  'reference',
  'vector',
  'interactions',
  'react',
  'web',
  'webSlots',
  'webProps',
  'shape',
  'stroke',
  'strokeWidth',
  'dash',
  'opacity',
  'radius',
  'rotation',
  'flipX',
  'flipY',
  'locked',
  'hidden',
  'typography',
  'runs',
  'imageFit',
  'crop',
  'alt',
  'arrowhead',
]);
function componentPart(c: DesignComponent, id: string): DesignElement {
  const part = c.elements?.find((e) => e.id === id);
  if (part) return part;
  if (!c.elements && id === 'root')
    return {
      ...defaultDesignElement(c.template.type, 0, id),
      ...c.template,
      bounds: { x: 0, y: 0, width: c.width, height: c.height },
    };
  return rejectDesign('design-target', 'Design component part not found', id);
}
function patchFields(value: unknown, allowed: readonly string[], path: string) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    rejectDesign('design-patch', 'Unknown or invalid structured Design patch field', path);
  return value;
}
const textStyleFields = [
  'fontFamily',
  'fontSize',
  'bold',
  'italic',
  'underline',
  'strike',
  'color',
  'lineHeight',
  'letterSpacing',
  'align',
  'verticalAlign',
  'padding',
  'list',
  'overflow',
];
/** Close native envelopes only. Public props, slot/breakpoint maps and retained
 * foreign content keep their declared dictionary/domain-owned semantics. Web,
 * React and interaction structures use their existing strict validators below. */
function assertPatchStructures(patch: Record<string, unknown>, path: string) {
  const structures: Record<string, readonly string[]> = {
    bounds: ['x', 'y', 'width', 'height'],
    layout: ['direction', 'gap', 'padding', 'align', 'sizing'],
    constraints: ['horizontal', 'vertical'],
    crop: ['x', 'y', 'scale'],
    typography: textStyleFields,
  };
  for (const [key, allowed] of Object.entries(structures))
    if (patch[key] !== undefined) patchFields(patch[key], allowed, `${path}.${key}`);
  if (patch.runs !== undefined) {
    if (!Array.isArray(patch.runs)) rejectDesign('design-patch', 'Expected text runs', path);
    patch.runs.forEach((run, i) => {
      const r = patchFields(run, ['text', 'style'], `${path}.runs.${i}`);
      if (r.style !== undefined) patchFields(r.style, textStyleFields, `${path}.runs.${i}.style`);
    });
  }
  if (patch.vector !== undefined) {
    const vector = patchFields(patch.vector, ['viewBox', 'paths', 'provenance'], `${path}.vector`);
    patchFields(vector.viewBox, structures.bounds, `${path}.vector.viewBox`);
    patchFields(
      vector.provenance,
      ['source', 'name', 'version', 'license'],
      `${path}.vector.provenance`,
    );
  }
  if (patch.reference !== undefined) {
    const ref = patchFields(
      patch.reference,
      ['schemaVersion', 'source', 'mode', 'fit', 'snapshot'],
      `${path}.reference`,
    );
    const source = patchFields(
      ref.source,
      ['artifactId', 'domain', 'target'],
      `${path}.reference.source`,
    );
    patchFields(
      source.target,
      ['kind', 'viewId', 'columnIds', 'rowIds', 'nodeIds'],
      `${path}.reference.source.target`,
    );
    const snapshot = patchFields(
      ref.snapshot,
      ['artifactId', 'domain', 'versionId', 'revision', 'contentHash', 'content', 'dependencies'],
      `${path}.reference.snapshot`,
    );
    if (!Array.isArray(snapshot.dependencies))
      rejectDesign('design-patch', 'Expected reference dependencies', path);
    snapshot.dependencies.forEach((dependency, i) =>
      patchFields(
        dependency,
        ['id', 'contentHash', 'content'],
        `${path}.reference.snapshot.dependencies.${i}`,
      ),
    );
  }
}
function assertElementChange(
  d: DesignContent,
  element: DesignElement,
  patch: unknown,
  scope = d.elements,
  templateOnly = false,
): asserts patch is Partial<DesignElement> {
  assertPatchShape(element, patch);
  const next = { ...element, ...patch } as DesignElement;
  if (!validElement(next))
    rejectDesign('design-patch', 'Invalid Design element values', element.id);
  // Schema 1/2 component templates can have type instance without retaining a
  // componentId. Only the synthetic template projection skips that element check.
  if (next.type === 'instance' && !templateOnly) targetComponent(d, next.componentId ?? '');
  if (patch.parentId !== undefined) assertParentPatch(scope, element, patch.parentId);
  if (patch.styleId !== undefined && !d.styles?.some((s) => s.id === patch.styleId))
    rejectDesign('design-target', 'Design style not found', element.id);
  if (patch.interactions !== undefined)
    assertDesignInteractionTargets(d, patch.interactions as DesignInteraction[]);
  if (patch.overrides !== undefined)
    assertOverridesPatch(d, next, patch.overrides as Record<string, unknown>);
}
function assertPatchShape(
  element: DesignElement,
  patch: unknown,
): asserts patch is Partial<DesignElement> {
  if (!record(patch) || Object.keys(patch).some((key) => !elementFields.has(key)))
    rejectDesign('design-patch', 'Unknown or immutable Design element field', element.id);
  assertPatchStructures(patch, element.id);
  if (Object.hasOwn(patch, 'type') && patch.type !== element.type)
    rejectDesign('design-type', 'Element type is immutable in a Design patch', element.id);
  if (Object.hasOwn(patch, 'react')) assertReactPatch(element, patch.react);
}
function assertReactPatch(element: DesignElement, react: unknown) {
  if (
    element.type !== 'react' ||
    !element.react ||
    !record(react) ||
    ['component', 'import', 'slots'].some(
      (key) =>
        canonicalJson(react[key]) !==
        canonicalJson(element.react![key as keyof DesignReactReference]),
    )
  )
    rejectDesign(
      'design-react',
      'Use registered React commands to change component identity or slots',
      element.id,
    );
}
function assertParentPatch(scope: DesignElement[], element: DesignElement, parentId: unknown) {
  if (
    typeof parentId !== 'string' ||
    !scope.some((e) => e.id === parentId && ['frame', 'group'].includes(e.type))
  )
    rejectDesign('design-parent', 'Parent must be an existing frame or group', element.id);
  if (descendantIds(scope, [element.id]).has(parentId as string))
    rejectDesign('design-parent', 'A layer cannot become its own ancestor', element.id);
  assertEditable(scope, [parentId as string]);
}
function assertOverridesPatch(
  d: DesignContent,
  next: DesignElement,
  overrides: Record<string, unknown>,
) {
  const c = targetComponent(d, next.componentId ?? '');
  for (const [id, override] of Object.entries(overrides))
    assertElementChange(d, componentPart(c, id), override, c.elements ?? [], !c.elements);
  if (
    c.elements &&
    !validElements(
      c.elements.map((part) =>
        applyDesignOverride(part, (overrides as DesignElement['overrides'])?.[part.id]),
      ),
    )
  )
    rejectDesign('design-patch', 'Invalid effective component part hierarchy or values');
}
export function assertDesignInteractionTargets(
  d: DesignContent,
  interactions: DesignInteraction[] | undefined,
): void {
  if (
    interactions !== undefined &&
    (!validDesignInteractions(interactions) ||
      interactions.some(
        (i) =>
          'frameId' in i.action &&
          !d.elements.some(
            (e) => e.type === 'frame' && e.id === ('frameId' in i.action ? i.action.frameId : ''),
          ),
      ))
  )
    rejectDesign('design-prototype-target', 'Interaction target must be an existing Design frame');
}
function insertPlaced(
  d: DesignContent,
  element: DesignElement,
  options: DesignPlacement,
): DesignContent {
  const raw: unknown = options;
  if (
    !record(raw) ||
    Object.keys(raw).some((k) => !['id', 'bounds', 'parentId', 'index', 'src'].includes(k))
  )
    rejectDesign('design-placement', 'Unknown Design insertion option');
  if (options.id !== undefined) designId(options.id);
  if (options.bounds !== undefined && !validBounds(options.bounds))
    rejectDesign('design-bounds', 'Invalid insertion bounds');
  designId(element.id);
  if (d.elements.some((e) => e.id === element.id))
    rejectDesign('design-id', 'Duplicate Design element ID', element.id);
  if (options.parentId !== undefined) {
    const parent = targetElement(d, options.parentId);
    if (!['frame', 'group'].includes(parent.type))
      rejectDesign('design-parent', 'Parent must be a frame or group', options.parentId);
    assertEditable(d.elements, [parent.id]);
  }
  const index = options.index ?? d.elements.length;
  if (!Number.isSafeInteger(index) || index < 0 || index > d.elements.length)
    rejectDesign('design-index', 'Insertion index must be within the native elements array');
  const elements = [...d.elements];
  elements.splice(index, 0, {
    ...element,
    ...(options.bounds ? { bounds: clone(options.bounds) } : {}),
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
  });
  return { ...d, elements };
}
export const insertElement = (
  type: DesignElementType,
  source?: string | DesignInsertOptions,
): DesignInsertionCommand => {
  if (source !== undefined && typeof source !== 'string' && !record(source as unknown))
    rejectDesign('design-placement', 'Expected an image source string or insertion options');
  const options = captureDesignData(
    typeof source === 'string' ? (source ? { src: source } : {}) : (source ?? {}),
  );
  const elementId = options.id ?? newId('design');
  return {
    ...withCommandReads(
      command('design.insert', `Add ${type}`, (d) => {
        if (!['frame', 'rectangle', 'text', 'image', 'group', 'shape'].includes(type))
          rejectDesign(
            'design-type',
            'Use the registered component insertion API for instances and React',
          );
        return insertPlaced(
          d,
          {
            ...defaultDesignElement(type, d.elements.length, elementId),
            ...(options.src === undefined ? {} : { src: options.src }),
          },
          options,
        );
      }),
      { content: ['*'] },
    ),
    elementId,
  };
};
/** Create an editable, attributed icon/path shape; colors use normal fill/stroke styles. */
export function makeDesignVector(vector: DesignVector, index = 0): DesignElement {
  if (!validDesignVector(vector)) throw new Error('Invalid Design vector geometry or provenance');
  const element = makeDesignElement('shape', index);
  return {
    ...element,
    name: vector.provenance.name,
    bounds: {
      ...element.bounds,
      width: Math.max(1, vector.viewBox.width),
      height: Math.max(1, vector.viewBox.height),
    },
    vector: clone(vector),
    fill: 'none',
    stroke: '#253044',
    strokeWidth: 2,
  };
}
export const updateElement = (
  id: string,
  patch: Partial<Omit<DesignElement, 'id'>>,
): EditorCommand<DesignContent> => {
  const owned = captureDesignData(patch);
  return command('design.update', 'Edit element', (d) => {
    const e = targetElement(d, id);
    assertEditable(d.elements, [id]);
    assertElementChange(d, e, owned);
    return { ...d, elements: d.elements.map((e) => (e.id === id ? { ...e, ...owned } : e)) };
  });
};
function descendants(d: DesignContent, ids: string[]): Set<string> {
  const all = new Set(ids);
  let added = true;
  while (added) {
    added = false;
    for (const e of d.elements)
      if (e.parentId && all.has(e.parentId) && !all.has(e.id)) {
        all.add(e.id);
        added = true;
      }
  }
  return all;
}
export const transformElements = (
  ids: string[],
  delta: TransformDelta,
): EditorCommand<DesignContent> => {
  ids = captureDesignData(ids);
  delta = captureDesignData(delta);
  return withCommandReads<DesignContent>(
    immutableCommand('design.transform', 'Transform elements', (d) => {
      if (
        !record(delta as unknown) ||
        Object.keys(delta).some((key) => !['dx', 'dy', 'dw', 'dh', 'rotation'].includes(key)) ||
        ['dx', 'dy', 'dw', 'dh'].some(
          (key) =>
            typeof delta[key as keyof TransformDelta] !== 'number' ||
            !Number.isFinite(delta[key as keyof TransformDelta]),
        ) ||
        (delta.rotation !== undefined && !Number.isFinite(delta.rotation))
      )
        rejectDesign('design-transform', 'Invalid Design transform delta');
      for (const id of ids) targetElement(d, id);
      const next = transformDesign(d, ids, delta);
      assertDesignContent(next);
      return next;
    }),
    { geometry: ids },
  );
};

/** Relationships stay fixed throughout one geometry/layout operation. */
function designGeometryIndex(elements: DesignElement[]) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const children = new Map<string, DesignElement[]>();
  for (const element of elements)
    if (element.parentId) {
      const siblings = children.get(element.parentId) ?? [];
      siblings.push(element);
      children.set(element.parentId, siblings);
    }
  return { byId, children };
}
type DesignGeometryIndex = ReturnType<typeof designGeometryIndex>;
function geometryDescendants(index: DesignGeometryIndex, id: string) {
  const result: DesignElement[] = [];
  const seen = new Set([id]);
  const queue = [id];
  for (let i = 0; i < queue.length; i++)
    for (const child of index.children.get(queue[i]) ?? [])
      if (!seen.has(child.id)) {
        seen.add(child.id);
        result.push(child);
        queue.push(child.id);
      }
  return result;
}
/** World-coordinate storage; frame children follow local constraints, Groups scale geometry. */
function placeDesignElement(index: DesignGeometryIndex, id: string, bounds: Bounds) {
  const element = index.byId.get(id)!;
  const old = { ...element.bounds };
  element.bounds = { ...bounds };
  if (element.type === 'frame') {
    for (const child of index.children.get(id) ?? []) {
      const next = { ...child.bounds };
      for (const [axis, size, rule] of [
        ['x', 'width', child.constraints?.horizontal ?? 'left'],
        ['y', 'height', child.constraints?.vertical ?? 'top'],
      ] as const) {
        const offset = next[axis] - old[axis],
          delta = bounds[size] - old[size];
        next[axis] = bounds[axis] + offset;
        if (rule === 'right' || rule === 'bottom') next[axis] += delta;
        if (rule === 'center') next[axis] += delta / 2;
        if (rule === 'stretch') next[size] = Math.max(1, next[size] + delta);
        if (rule === 'scale') {
          next[axis] = bounds[axis] + (offset * bounds[size]) / old[size];
          next[size] = Math.max(1, (next[size] * bounds[size]) / old[size]);
        }
      }
      placeDesignElement(index, child.id, next);
    }
  } else {
    for (const child of geometryDescendants(index, id)) {
      child.bounds = {
        x: bounds.x + ((child.bounds.x - old.x) * bounds.width) / old.width,
        y: bounds.y + ((child.bounds.y - old.y) * bounds.height) / old.height,
        width: Math.max(1, (child.bounds.width * bounds.width) / old.width),
        height: Math.max(1, (child.bounds.height * bounds.height) / old.height),
      };
    }
  }
}
export function transformDesign(
  d: DesignContent,
  ids: string[],
  delta: TransformDelta,
): DesignContent {
  const projection = transformGeometry(d.elements, ids, delta);
  // Layout changes geometry only. Certified immutable appearance/definitions may
  // be shared; mutable and merely shallow-frozen caller trees still need a copy.
  const elements = d.elements.map((e) =>
    isDeepFrozen(e) ? { ...e, bounds: { ...e.bounds } } : clone(e),
  );
  const index = designGeometryIndex(elements);
  if (delta.rotation) {
    for (const e of elements) if (projection.has(e.id)) Object.assign(e, projection.get(e.id));
  } else {
    for (const root of selectedRoots(d.elements, ids)) {
      if (index.byId.get(root.id)!.type === 'frame')
        placeDesignElement(index, root.id, projection.get(root.id)!.bounds);
      else {
        for (const e of [index.byId.get(root.id)!, ...geometryDescendants(index, root.id)])
          Object.assign(e, projection.get(e.id));
      }
    }
  }
  const next = layoutOwnedDesign({ ...d, elements }, index);
  next.elements = next.elements.map((e, i) => {
    const before = d.elements[i];
    return isDeepFrozen(before) &&
      e.rotation === before.rotation &&
      e.bounds.x === before.bounds.x &&
      e.bounds.y === before.bounds.y &&
      e.bounds.width === before.bounds.width &&
      e.bounds.height === before.bounds.height
      ? before
      : e;
  });
  return next;
}
export function designPreview(d: DesignContent, ids: string[], delta: TransformDelta) {
  return new Map(
    transformDesign(d, ids, delta).elements.map((e) => [
      e.id,
      { bounds: e.bounds, rotation: e.rotation ?? 0 },
    ]),
  );
}
export const deleteElements = (ids: string[]): EditorCommand<DesignContent> =>
  withCommandReads<DesignContent>(
    command('design.delete', 'Delete elements', (d) => {
      const all = descendants(d, ids);
      const elements = d.elements
        .filter((e) => !all.has(e.id))
        .map((e) => {
          const clean = (slots: Record<string, string[]>) =>
            Object.fromEntries(
              Object.entries(slots).map(([slot, children]) => {
                const remaining = children.filter((id) => !all.has(id));
                if (remaining.length !== children.length) {
                  const contract = e.react
                    ? d.web?.registrations.find(
                        (c) => reactComponentKey(c.ref) === reactComponentKey(e.react!.component),
                      )?.slots[slot]
                    : d.components.find((c) => c.id === e.componentId)?.web?.slots?.[slot];
                  if (!contract || remaining.length < contract.minimum)
                    throw new Error(
                      `Delete would violate public slot minimum: ${e.id}/${slot}; delete the owner or retain its required children`,
                    );
                }
                return [slot, remaining];
              }),
            );
          return {
            ...e,
            ...(e.react ? { react: { ...e.react, slots: clean(e.react.slots) } } : {}),
            ...(e.webSlots ? { webSlots: clean(e.webSlots) } : {}),
          };
        });
      return { ...d, elements };
    }),
    { content: ['*'] },
  );
export const duplicateElements = (ids: string[]): EditorCommand<DesignContent> =>
  withCommandReads<DesignContent>(
    command('design.duplicate', 'Duplicate elements', (d) => {
      const all = descendants(d, ids),
        copies = d.elements.filter((e) => all.has(e.id));
      const mapping = new Map(copies.map((e) => [e.id, newId('design')]));
      const owners = d.elements.map((e) => {
        if (all.has(e.id)) return e;
        const slots = e.react?.slots ?? e.webSlots;
        if (
          !slots ||
          !Object.values(slots)
            .flat()
            .some((id) => mapping.has(id))
        )
          return e;
        const definitions = e.react
          ? d.web?.registrations.find(
              (c) => reactComponentKey(c.ref) === reactComponentKey(e.react!.component),
            )?.slots
          : d.components.find((c) => c.id === e.componentId)?.web?.slots;
        const nextSlots = Object.fromEntries(
          Object.entries(slots).map(([slot, ids]) => {
            const next = ids.flatMap((id) => (mapping.has(id) ? [id, mapping.get(id)!] : [id]));
            const contract = definitions?.[slot];
            if (!contract || next.length > contract.maximum || next.length < contract.minimum)
              throw new Error('Duplicate would violate public slot limits: ' + slot);
            return [slot, next];
          }),
        );
        return {
          ...e,
          ...(e.react ? { react: { ...e.react, slots: nextSlots } } : { webSlots: nextSlots }),
        };
      });
      return {
        ...d,
        elements: [
          ...owners,
          ...copies.map((e) => ({
            ...remapDesignInteractionTargets(clone(e), mapping),
            id: mapping.get(e.id)!,
            name: `${e.name} copy`,
            parentId: e.parentId ? (mapping.get(e.parentId) ?? e.parentId) : undefined,
            ...(e.react
              ? {
                  react: {
                    ...clone(e.react),
                    slots: Object.fromEntries(
                      Object.entries(e.react.slots).map(([slot, children]) => [
                        slot,
                        children.map((id) => mapping.get(id) ?? id),
                      ]),
                    ),
                  },
                }
              : {}),
            ...(e.webSlots
              ? {
                  webSlots: Object.fromEntries(
                    Object.entries(e.webSlots).map(([slot, children]) => [
                      slot,
                      children.map((id) => mapping.get(id) ?? id),
                    ]),
                  ),
                }
              : {}),
            bounds: { ...e.bounds, x: e.bounds.x + 30, y: e.bounds.y + 30 },
          })),
        ],
      };
    }),
    { content: ids },
  );
export const groupElements = (ids: string[]): EditorCommand<DesignContent> => {
  const template = makeDesignElement('group');
  return withCommandReads<DesignContent>(
    command('design.group', 'Group elements', (d) => {
      const elements = assertEditable(d.elements, ids, true);
      if (elements.length < 2) throw new Error('Select at least two elements');
      const g = {
        ...template,
        bounds: unionBounds(elements.map((e) => e.bounds)),
        name: 'Group',
        parentId: elements[0].parentId,
      };
      return {
        ...d,
        elements: [
          g,
          ...d.elements.map((e) =>
            elements.some((root) => root.id === e.id) ? { ...e, parentId: g.id } : e,
          ),
        ],
      };
    }),
    { geometry: ids },
  );
};
export const alignElements = (
  ids: string[],
  mode: Alignment,
  reference?: Bounds,
): EditorCommand<DesignContent> =>
  withCommandReads<DesignContent>(
    command('design.align', `Align ${mode}`, (d) => {
      const m = alignGeometry(d.elements, ids, mode, reference);
      return {
        ...d,
        elements: d.elements.map((e) => (m.has(e.id) ? { ...e, bounds: m.get(e.id)! } : e)),
      };
    }),
    { geometry: ids },
  );
export const moveLayer = (id: string, delta: number): EditorCommand<DesignContent> =>
  command('design.layer', 'Reorder layer', (d) => {
    const elements = [...d.elements],
      index = elements.findIndex((e) => e.id === id),
      target = index + delta;
    if (index < 0 || target < 0 || target >= elements.length) return d;
    elements.splice(target, 0, elements.splice(index, 1)[0]);
    return { ...d, elements };
  });
export const createComponent = (
  input: string | string[],
  componentId = newId('component'),
): EditorCommand<DesignContent> =>
  withCommandReads<DesignContent>(
    command('design.component', 'Create component', (d) => {
      designId(componentId);
      const ids = typeof input === 'string' ? [input] : input,
        roots = assertEditable(d.elements, ids, true);
      if (!roots.length) throw new Error('Select at least one element');
      const all = descendantIds(d.elements, ids),
        parts = d.elements.filter((e) => all.has(e.id)),
        box = unionBounds(roots.map((e) => e.bounds));
      if (parts.some((e) => e.reference))
        throw new Error(
          '参照埋め込みのcomponent authoringは未対応です。参照を明示的に解除してください。',
        );
      const first = parts[0];
      const c: DesignComponent = {
        id: componentId,
        name: first.name,
        template: {
          type: first.type === 'react' ? 'frame' : first.type,
          text: first.text,
          fill: first.fill,
          src: first.src,
          typography: first.typography,
          runs: first.runs,
          stroke: first.stroke,
          strokeWidth: first.strokeWidth,
          opacity: first.opacity,
          shape: first.shape,
          radius: first.radius,
          dash: first.dash,
          alt: first.alt,
          imageFit: first.imageFit,
          crop: clone(first.crop),
          web: clone(first.web),
          ...(first.vector ? { vector: clone(first.vector) } : {}),
          ...(first.interactions ? { interactions: clone(first.interactions) } : {}),
        },
        width: box.width,
        height: box.height,
        ...(parts.length > 1 ||
        first.type === 'group' ||
        first.type === 'frame' ||
        first.type === 'react'
          ? {
              elements: parts.map((e) => ({
                ...clone(e),
                parentId: all.has(e.parentId ?? '') ? e.parentId : undefined,
                bounds: { ...e.bounds, x: e.bounds.x - box.x, y: e.bounds.y - box.y },
              })),
            }
          : {}),
      };
      return {
        ...d,
        components: [...d.components, c],
        elements: [
          ...d.elements.filter((e) => !all.has(e.id)),
          {
            ...first,
            ...(first.vector ? { vector: undefined } : {}),
            ...(first.interactions ? { interactions: undefined } : {}),
            id: first.id,
            type: 'instance',
            componentId: c.id,
            bounds: box,
            parentId: roots[0].parentId,
            overrides: {},
          },
        ],
      };
    }),
    { content: typeof input === 'string' ? [input] : input },
  );
export const insertInstance = (
  id: string,
  placement: DesignPlacement = {},
): DesignInsertionCommand => {
  if (!record(placement as unknown))
    rejectDesign('design-placement', 'Expected instance insertion options');
  const options = captureDesignData(placement);
  const elementId = options.id ?? newId('design');
  return {
    ...withCommandReads(
      command('design.instance', 'Insert component instance', (d) => {
        if (Object.hasOwn(options, 'src'))
          rejectDesign('design-placement', 'Instance placement does not accept src');
        const c = targetComponent(d, id);
        const element = defaultDesignElement('instance', d.elements.length, elementId);
        return insertPlaced(
          d,
          {
            ...element,
            name: `${c.name} instance`,
            componentId: c.id,
            bounds: { ...element.bounds, width: c.width, height: c.height },
          },
          options,
        );
      }),
      { content: ['*'] },
    ),
    elementId,
  };
};
export const updateComponent = (
  id: string,
  patch: Partial<DesignComponent['template']>,
): EditorCommand<DesignContent> => {
  const owned = captureDesignData(patch);
  return command('design.component-update', 'Update component definition', (d) => {
    const c = targetComponent(d, id);
    assertElementChange(
      d,
      {
        ...defaultDesignElement(c.template.type, 0, 'root'),
        ...c.template,
        bounds: { x: 0, y: 0, width: c.width, height: c.height },
      },
      owned,
      [],
      true,
    );
    if (
      Object.keys(owned).some(
        (key) =>
          ![
            'type',
            'text',
            'fill',
            'typography',
            'runs',
            'stroke',
            'strokeWidth',
            'opacity',
            'shape',
            'radius',
            'dash',
            'alt',
            'imageFit',
            'crop',
            'web',
            'interactions',
            'vector',
            'src',
          ].includes(key),
      )
    )
      rejectDesign('design-patch', 'Unsupported Design component template field', id);
    return {
      ...d,
      components: d.components.map((c) =>
        c.id === id ? { ...c, template: { ...c.template, ...owned } } : c,
      ),
    };
  });
};
export function appearance(d: DesignContent, e: DesignElement): DesignElement {
  const c = e.type === 'instance' ? d.components.find((c) => c.id === e.componentId) : undefined,
    shared = d.styles?.find((s) => s.id === e.styleId)?.appearance ?? {};
  return c && !c.elements
    ? applyDesignOverride(
        {
          ...e,
          ...c.template,
          ...shared,
          vector: c.template.vector,
          interactions: e.interactions ?? c.template.interactions,
        },
        e.overrides?.root,
      )
    : { ...e, ...shared, vector: e.vector };
}
/** Native partial overrides inherit unmodified text/layout fields from their part. */
export function applyDesignOverride(
  part: DesignElement,
  override?: Partial<DesignElement>,
): DesignElement {
  return {
    ...part,
    ...override,
    ...(part.interactions !== undefined || override?.interactions !== undefined
      ? { interactions: override?.interactions ?? part.interactions }
      : {}),
    ...(override?.typography ? { typography: { ...part.typography, ...override.typography } } : {}),
    ...(override?.layout ? { layout: { ...part.layout!, ...override.layout } } : {}),
  };
}
function frameClips(index: ReadonlyMap<string, DesignElement>, e: DesignElement) {
  const clips: (Bounds & { rotation?: number })[] = [];
  let parent = e.parentId ? index.get(e.parentId) : undefined;
  const seen = new Set<string>();
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    if (parent.type === 'frame' && parent.clipContent)
      clips.push({ ...parent.bounds, rotation: parent.rotation });
    parent = parent.parentId ? index.get(parent.parentId) : undefined;
  }
  return clips;
}
function instanceParts(
  c: DesignComponent,
  raw: DesignElement,
  idFor: (id: string) => string,
): DesignElement[] {
  const sx = raw.bounds.width / c.width,
    sy = raw.bounds.height / c.height;
  const cx = raw.bounds.x + raw.bounds.width / 2,
    cy = raw.bounds.y + raw.bounds.height / 2;
  const angle = ((raw.rotation ?? 0) * Math.PI) / 180;
  const reflected = !!raw.flipX !== !!raw.flipY;
  return (c.elements ?? []).map((part) => {
    const child = applyDesignOverride(part, raw.overrides?.[part.id]);
    const width = child.bounds.width * sx,
      height = child.bounds.height * sy;
    const dx = (child.bounds.x * sx + width / 2 - raw.bounds.width / 2) * (raw.flipX ? -1 : 1);
    const dy = (child.bounds.y * sy + height / 2 - raw.bounds.height / 2) * (raw.flipY ? -1 : 1);
    return {
      ...child,
      id: idFor(part.id),
      parentId: part.parentId ? idFor(part.parentId) : raw.id,
      bounds: {
        x: cx + dx * Math.cos(angle) - dy * Math.sin(angle) - width / 2,
        y: cy + dx * Math.sin(angle) + dy * Math.cos(angle) - height / 2,
        width,
        height,
      },
      rotation: (raw.rotation ?? 0) + (child.rotation ?? 0) * (reflected ? -1 : 1),
      flipX: !!raw.flipX !== !!child.flipX,
      flipY: !!raw.flipY !== !!child.flipY,
    };
  });
}
function designPartAppearance(
  d: DesignContent,
  part: DesignElement,
  override?: Partial<DesignElement>,
): DesignElement {
  const nested =
    part.type === 'instance'
      ? d.components.find((c) => c.id === (override?.componentId ?? part.componentId))
      : undefined;
  const primitive = nested && !nested.elements;
  const styled = appearance(d, {
    ...part,
    ...(override?.styleId ? { styleId: override.styleId } : {}),
    ...(primitive
      ? { componentId: nested.id, overrides: override?.overrides ?? part.overrides }
      : {}),
  });
  const patched = applyDesignOverride(styled, override);
  // Resolve primitive templates before direct part overrides, then explicit roots.
  return {
    ...(primitive ? applyDesignOverride(patched, override?.overrides?.root) : patched),
    ...(primitive ? { type: styled.type } : {}),
    styleId: undefined,
  };
}
/** The same effective layout, overrides and world geometry used by canvas/export. */
export function designInstanceElements(
  d: DesignContent,
  raw: DesignElement,
  idFor: (id: string) => string = (id) => id,
): DesignElement[] {
  const c = d.components.find((c) => c.id === raw.componentId);
  if (!c?.elements) return [];
  const effective = c.elements.map((part) =>
    designPartAppearance(d, part, raw.overrides?.[part.id]),
  );
  const local = effective.some((part) => part.layout && part.layout.direction !== 'absolute')
    ? layoutDesignElements(effective)
    : effective;
  return instanceParts({ ...c, elements: local }, { ...appearance(d, raw), overrides: {} }, idFor);
}
/** Call-scoped projector for one immutable render/export snapshot. */
export function designDrawingProjector(d: DesignContent) {
  const index = new Map(d.elements.map((e) => [e.id, e]));
  const elements = new Map(d.elements.map((e, i) => [e.id, ['elements', i] as DesignSourcePath]));
  const components = new Map(
    d.components.map((c, i) => [c.id, ['components', i] as DesignSourcePath]),
  );
  return (raw: DesignElement) =>
    projectDesignDrawing(d, raw, index, raw.id, {
      content: d,
      components,
      owners: elements.has(raw.id) ? [elements.get(raw.id)!] : [],
    });
}
export function designDrawings(d: DesignContent, raw: DesignElement): DesignDrawing[] {
  return designDrawingProjector(d)(raw);
}
/** Private drawing-hierarchy IDs for instance parts that cannot alias native records. */
function allocatePartIds(d: DesignContent, instanceId: string, c: DesignComponent) {
  const occupied = new Set(d.elements.map((e) => e.id));
  const partIds = new Map<string, string>();
  for (const part of c.elements ?? []) {
    const base = `${instanceId}-${part.id}`;
    let id = base,
      suffix = 0;
    while (occupied.has(id)) id = `${base}-${suffix++}`;
    occupied.add(id);
    partIds.set(part.id, id);
  }
  return partIds;
}
/** Source paths that own a part's editable values, most specific first. */
function partOwners(
  raw: DesignElement,
  part: DesignElement,
  partOwner: DesignSourcePath,
  enclosingOwner: DesignSourcePath | undefined,
  primitive: DesignComponent | undefined,
  sources: DesignDrawingSources,
): DesignSourcePath[] {
  if (!primitive) return [...(enclosingOwner ? [enclosingOwner] : []), partOwner];
  return [
    ...(enclosingOwner ? [[...enclosingOwner, 'overrides', 'root'], enclosingOwner] : []),
    ...(raw.overrides?.[part.id]?.overrides === undefined
      ? [[...partOwner, 'overrides', 'root']]
      : []),
    [...sources.components.get(primitive.id)!, 'template'],
  ];
}
function projectInstanceParts(
  d: DesignContent,
  raw: DesignElement,
  e: DesignElement,
  c: DesignComponent & { elements: DesignElement[] },
  drawingId: string,
  sources: DesignDrawingSources,
  locked: boolean,
  overrideOwner: DesignSourcePath | undefined,
): DesignDrawing[] {
  const partIds = allocatePartIds(d, raw.id, c);
  const parts = designInstanceElements(d, e, (id) => partIds.get(id)!);
  const virtual = {
    ...d,
    elements: [...d.elements.filter((e) => e.id !== raw.id), e, ...parts],
    components: d.components.filter((x) => x.id !== c.id),
  };
  const addresses = new Map(
    c.elements.map((part, partIndex) => [
      partIds.get(part.id)!,
      { drawingId: `${drawingId}-${part.id}`, part, partIndex },
    ]),
  );
  const virtualIndex = new Map(virtual.elements.map((e) => [e.id, e]));
  // Private hierarchy IDs cannot alias native records. Keep existing public
  // drawing addresses while preserving ancestor clipping and hidden state.
  return designPaintOrder(virtual)
    .filter((e) => addresses.has(e.id))
    .flatMap((e) => {
      const address = addresses.get(e.id)!;
      const native = applyDesignOverride(address.part, raw.overrides?.[address.part.id]);
      const primitive =
        native.type === 'instance'
          ? d.components.find((c) => c.id === native.componentId && !c.elements)
          : undefined;
      const partOwner = [...sources.components.get(c.id)!, 'elements', address.partIndex];
      const enclosingOwner = overrideOwner
        ? [...overrideOwner, 'overrides', address.part.id]
        : undefined;
      return projectDesignDrawing(virtual, e, virtualIndex, address.drawingId, {
        ...sources,
        instance: {
          elementId: sources.instance?.elementId ?? raw.id,
          partIds: [
            ...(sources.instance?.partIds ?? []),
            address.part.id,
            ...(primitive ? ['root'] : []),
          ],
        },
        locked: locked || lockedAncestor(virtual, virtualIndex, e),
        owners: partOwners(raw, address.part, partOwner, enclosingOwner, primitive, sources),
      });
    });
}
const drawingKind = (type: DesignElement['type']): DesignDrawing['kind'] =>
  type === 'text' ? 'text' : type === 'image' ? 'image' : type === 'group' ? 'group' : 'shape';
function projectDesignDrawing(
  d: DesignContent,
  raw: DesignElement,
  index: ReadonlyMap<string, DesignElement>,
  drawingId: string,
  sources: DesignDrawingSources,
): DesignDrawing[] {
  const e = appearance(d, raw);
  if (raw.hidden || e.hidden) return [];
  const locked = sources.locked || !!raw.locked || !!e.locked;
  const c =
    raw.type === 'instance' ? d.components.find((c) => c.id === raw.componentId) : undefined;
  const overrideOwner = sources.owners.find(
    (path) => designValueAt(sources.content, path)?.overrides !== undefined,
  );
  if (c?.elements)
    return projectInstanceParts(
      d,
      raw,
      e,
      { ...c, elements: c.elements },
      drawingId,
      sources,
      locked,
      overrideOwner,
    );
  const primitive = c && !c.elements ? c : undefined;
  const { textOwner, textInstance } = textSource(raw, primitive, sources, overrideOwner);
  const editable =
    !!textInstance &&
    textInstance.partIds.length <= 16 &&
    !locked &&
    unlockedVisibleText(d, index, raw, e);
  return [
    leafDrawing(
      e,
      raw,
      drawingId,
      index,
      textOwner,
      editable ? { ...textInstance!, name: raw.name } : undefined,
    ),
  ];
}
/** A primitive (template-only) instance edits its template text through the instance root. */
const unlockedVisibleText = (
  d: DesignContent,
  index: ReadonlyMap<string, DesignElement>,
  raw: DesignElement,
  e: DesignElement,
) =>
  !e.locked &&
  !e.hidden &&
  !lockedAncestor(d, index, raw) &&
  ['text', 'shape', 'rectangle'].includes(e.type);
function textSource(
  raw: DesignElement,
  primitive: DesignComponent | undefined,
  sources: DesignDrawingSources,
  overrideOwner: DesignSourcePath | undefined,
) {
  const textOwners = primitive
    ? [
        ...(overrideOwner ? [[...overrideOwner, 'overrides', 'root']] : []),
        [...sources.components.get(primitive.id)!, 'template'],
        ...sources.owners,
      ]
    : sources.owners;
  const textOwner = textOwners.find(
    (path) => typeof designValueAt(sources.content, path)?.text === 'string',
  );
  const textInstance = primitive
    ? {
        elementId: sources.instance?.elementId ?? raw.id,
        partIds: [...(sources.instance?.partIds ?? []), 'root'],
      }
    : sources.instance;
  return { textOwner, textInstance };
}
function leafDrawing(
  e: DesignElement,
  raw: DesignElement,
  drawingId: string,
  index: ReadonlyMap<string, DesignElement>,
  textOwner: DesignSourcePath | undefined,
  instanceText: DesignDrawing['instanceText'],
): DesignDrawing {
  return {
    ...e,
    id: drawingId,
    imageFit: raw.reference ? (raw.reference.fit === 'cover' ? 'fill' : 'fit') : e.imageFit,
    textSourcePath: textOwner ? [...textOwner, 'text'] : undefined,
    instanceText,
    vector: e.type === 'shape' && validDesignVector(e.vector) ? e.vector : undefined,
    clipBounds: frameClips(index, raw),
    kind: drawingKind(e.type),
    shape: e.shape ?? 'rectangle',
    typography: e.typography ?? { fontSize: 28 },
    text: e.type === 'frame' ? '' : e.text,
  };
}
function lockedAncestor(
  d: DesignContent,
  index: ReadonlyMap<string, DesignElement>,
  e: DesignElement,
): boolean {
  const seen = new Set<string>();
  let parent = e.parentId ? index.get(e.parentId) : undefined;
  while (parent && !seen.has(parent.id)) {
    const effective = appearance(d, parent);
    if (parent.locked || parent.hidden || effective.locked || effective.hidden) return true;
    seen.add(parent.id);
    parent = parent.parentId ? index.get(parent.parentId) : undefined;
  }
  return false;
}
function assertDesignPathEditable(
  d: DesignContent,
  scope: DesignElement[],
  id: string,
  skipSelf = false,
) {
  const index = new Map(scope.map((e) => [e.id, e]));
  const seen = new Set<string>();
  let element = index.get(id);
  while (element && !seen.has(element.id)) {
    const effective = appearance(d, element);
    if (
      (!skipSelf || element.id !== id) &&
      (element.locked || element.hidden || effective.locked || effective.hidden)
    )
      rejectDesign(
        'design-target',
        'Unlock and show the addressed element and its ancestors before editing',
        id,
      );
    seen.add(element.id);
    element = element.parentId ? index.get(element.parentId) : undefined;
  }
}
export function designDiff(a: DesignContent, b: DesignContent): CompareResult {
  const interactions = (items: DesignInteraction[] | undefined) =>
    items
      ?.map(
        (i) =>
          `${i.trigger}: ${i.action.type}${'frameId' in i.action ? ` → ${i.action.frameId}` : ''}`,
      )
      .join('\n') ?? 'Inherited / none';
  const describe = (e: DesignElement, side: 'before' | 'after' = 'after') => {
    const context = side === 'before' ? a : b;
    return `${e.name}${describeReference(e)}\nParent: ${context.elements.find((p) => p.id === e.parentId)?.name ?? 'pasteboard'}\n${designDrawings(context, e).map(describeDrawing).join('\n\n')}${e.layout ? `\nLayout: ${e.layout.direction}, gap ${e.layout.gap}, padding ${e.layout.padding}` : ''}${e.componentId ? `\nComponent: ${context.components.find((c) => c.id === e.componentId)?.name ?? e.componentId}` : ''}\nInteractions: ${interactions(e.interactions)}${
      e.overrides
        ? `\nPart interactions: ${Object.entries(e.overrides)
            .filter(([, p]) => p.interactions !== undefined)
            .map(([id, p]) => `${id}: ${interactions(p.interactions)}`)
            .join('\n')}`
        : ''
    }`;
  };
  return {
    changes: [
      ...describeChanges(a.elements, b.elements, (e) => `Layer: ${e.name}`, describe),
      ...describeChanges(
        a.components,
        b.components,
        (c) => `Component: ${c.name}`,
        (c, side) =>
          `${c.name}\n${c.elements?.map((e) => describe(e, side)).join('\n\n') ?? `${c.template.type}: ${c.template.text}\nFill: ${c.template.fill}\nInteractions: ${interactions(c.template.interactions)}${c.template.vector ? '\n' + describeVector(c.template.vector) : ''}`}`,
      ),
      ...describeChanges(
        [{ id: 'prototype-start', frameId: a.prototyping?.startFrameId }],
        [{ id: 'prototype-start', frameId: b.prototyping?.startFrameId }],
        () => 'Prototype start frame',
        (v) => v.frameId ?? 'First visible frame',
      ),
      ...describeChanges(
        a.prototyping?.flows ?? [],
        b.prototyping?.flows ?? [],
        (flow) => `Prototype flow: ${flow.name}`,
        (flow) => `${flow.name}\n${flow.frameIds.join(' → ')}`,
      ),
      ...describeChanges(
        a.styles ?? [],
        b.styles ?? [],
        (s) => `Style: ${s.name}`,
        (s) =>
          `${s.name}\n${Object.entries(s.appearance)
            .map(
              ([key, value]) =>
                `${key}: ${
                  typeof value === 'object'
                    ? Object.entries(value ?? {})
                        .map(([k, v]) => `${k} = ${v}`)
                        .join(', ')
                    : value
                }`,
            )
            .join('\n')}`,
      ),
    ],
  };
}
export function exportDesignSvg(
  d: DesignContent,
  ids?: string[],
  options: { padding?: number; background?: string } = {},
): string {
  const included = ids?.length ? descendantIds(d.elements, ids) : undefined;
  const chosen = designPaintOrder(d).filter((e) => !included || included.has(e.id));
  const box = unionBounds(chosen.filter((e) => !e.hidden).map((e) => e.bounds)),
    pad = options.padding ?? 20;
  return drawingSvg(
    chosen.flatMap(designDrawingProjector(d)),
    { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 },
    options.background,
  );
}
/** Native paint order with effective visibility, including hidden ancestor subtrees. */
export function designPaintOrder(d: DesignContent): DesignElement[] {
  return hierarchyPaintOrder(
    d.elements.map((e) => (!e.hidden && appearance(d, e).hidden ? { ...e, hidden: true } : e)),
    (e) => e.parentId,
  );
}
const checkedElements = new WeakSet<DesignElement>();
const checkedElementLists = new WeakSet<DesignElement[]>();
const checkedComponents = new WeakSet<DesignComponent>();
const optional = <T>(value: T | undefined, check: (value: T) => boolean) =>
  value === undefined || check(value);
const oneOf = (values: readonly unknown[]) => (value: unknown) => values.includes(value);
const validLayout = (layout: NonNullable<DesignElement['layout']>) =>
  record(layout) &&
  ['row', 'column', 'absolute'].includes(layout.direction) &&
  Number.isFinite(layout.gap) &&
  layout.gap >= 0 &&
  Number.isFinite(layout.padding) &&
  layout.padding >= 0 &&
  ['start', 'center', 'end'].includes(layout.align) &&
  ['fixed', 'hug'].includes(layout.sizing);
const validCrop = (crop: NonNullable<DesignElement['crop']>) =>
  !!crop &&
  Number.isFinite(crop.x) &&
  Number.isFinite(crop.y) &&
  Number.isFinite(crop.scale) &&
  crop.scale > 0;
const validConstraints = (constraints: NonNullable<DesignElement['constraints']>) =>
  !!constraints &&
  ['left', 'right', 'center', 'stretch', 'scale'].includes(constraints.horizontal) &&
  ['top', 'bottom', 'center', 'stretch', 'scale'].includes(constraints.vertical);
const validWebSlots = (slots: NonNullable<DesignElement['webSlots']>) =>
  validDesignWebData(slots) &&
  Object.values(slots).every(
    (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'),
  );
const validImageSource = (src: string) =>
  src === '' ||
  (typeof src === 'string' && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(src));
const optionalStringKeys = ['parentId', 'componentId', 'styleId', 'alt', 'dash'] as const;
/** Per-record element checks, in evaluation order. Relationships are checked on the list. */
const elementChecks: ((e: DesignElement) => boolean)[] = [
  (e) =>
    typeof e.id === 'string' &&
    typeof e.name === 'string' &&
    typeof e.text === 'string' &&
    typeof e.fill === 'string',
  (e) => optional(e.interactions, validDesignInteractions),
  (e) => optional(e.overrides, (o) => validDesignOverrides(o)),
  (e) => validVisualStyle(e),
  (e) => optional(e.reference, (r) => e.type === 'image' && validEmbeddedReference(r)),
  (e) => optional(e.vector, (v) => e.type === 'shape' && validDesignVector(v)),
  (e) =>
    ['frame', 'rectangle', 'text', 'image', 'group', 'instance', 'shape', 'react'].includes(e.type),
  (e) => optional(e.react, validDesignReactReference),
  (e) => optional(e.webProps, validDesignWebData),
  (e) => optional(e.webSlots, validWebSlots),
  (e) => e.type !== 'react' || !!e.react,
  (e) => optional(e.web, validDesignWebElement),
  (e) => validBounds(e.bounds),
  (e) => optional(e.layout, validLayout),
  (e) => optional(e.sizing, oneOf(['fixed', 'hug', 'fill'])),
  (e) => optional(e.clipContent, (v) => typeof v === 'boolean'),
  (e) => optional(e.shape, oneOf(shapeNames)),
  (e) => optional(e.imageFit, oneOf(['fit', 'fill'])),
  (e) => optional(e.arrowhead, oneOf(['none', 'end', 'both'])),
  (e) => optional(e.strokeWidth, (v) => v >= 0),
  (e) => optional(e.radius, (v) => v >= 0),
  (e) => optional(e.crop, validCrop),
  (e) =>
    optionalStringKeys.every((key) => optional(e[key] as unknown, (v) => typeof v === 'string')),
  (e) => optional(e.constraints, validConstraints),
  (e) => optional(e.src, validImageSource),
];
function validElement(e: DesignElement): boolean {
  if (checkedElements.has(e)) return true;
  const valid = !!e && elementChecks.every((check) => check(e));
  if (valid && isDeepFrozen(e)) checkedElements.add(e);
  return valid;
}
function validElements(elements: DesignElement[]): boolean {
  if (checkedElementLists.has(elements)) return true;
  const valid =
    new Set(elements.map((e) => e?.id)).size === elements.length &&
    elements.every(validElement) &&
    validHierarchy(elements);
  // Relationships belong to the complete list, never to an individual record.
  if (valid && isDeepFrozen(elements)) checkedElementLists.add(elements);
  return valid;
}
const validComponentTemplate = (t: DesignComponent['template']) =>
  !!t &&
  (t as Partial<DesignElement>).reference === undefined &&
  ['text', 'rectangle', 'image', 'shape', 'group', 'frame', 'instance'].includes(t.type) &&
  typeof t.text === 'string' &&
  typeof t.fill === 'string' &&
  optional(t.interactions, validDesignInteractions) &&
  validVisualStyle(t) &&
  optional(t.vector, (v) => t.type === 'shape' && validDesignVector(v)) &&
  optional(t.web, validDesignWebElement);
const validComponentSize = (c: DesignComponent) =>
  Number.isFinite(c.width) && c.width >= 1 && Number.isFinite(c.height) && c.height >= 1;
function validComponent(c: DesignComponent): boolean {
  if (checkedComponents.has(c)) return true;
  const valid =
    !!c &&
    !containsEmbeddedReference(c) &&
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    validComponentSize(c) &&
    optional(c.web, validDesignWebComponent) &&
    validComponentTemplate(c.template) &&
    optional(c.elements, (elements) => Array.isArray(elements) && validElements(elements));
  if (valid && isDeepFrozen(c)) checkedComponents.add(c);
  return valid;
}
export function isDesign(value: unknown): value is DesignContent {
  if (!value || typeof value !== 'object') return false;
  const d = value as DesignContent;
  return (
    (d.schemaVersion === 1 || d.schemaVersion === 2) &&
    Array.isArray(d.elements) &&
    validReferenceItems(d.elements) &&
    Array.isArray(d.components) &&
    validNativeReuse(d.reuse, 'design') &&
    (d.prototyping === undefined || validDesignPrototype(d.prototyping)) &&
    (d.web === undefined || validDesignWebSettings(d.web)) &&
    validElements(d.elements) &&
    d.components.every(validComponent) &&
    validReferencedVectorOverrides(d)
  );
}

/** Structural override checks need the referenced native scope to establish the effective type. */
function validReferencedVectorOverrides(content: DesignContent): boolean {
  const components = new Map(content.components.map((c) => [c.id, c]));
  const containsVector = (patch: Partial<DesignElement>): boolean =>
    patch.vector !== undefined || Object.values(patch.overrides ?? {}).some(containsVector);
  const visit = (element: Partial<DesignElement>, depth = 0): boolean => {
    if (element.vector !== undefined && element.type !== 'shape') return false;
    if (!element.overrides) return true;
    if (depth >= 16) return false;
    const component =
      element.type === 'instance' ? components.get(element.componentId ?? '') : undefined;
    return Object.entries(element.overrides).every(([id, patch]) => {
      const target = component?.elements
        ? component.elements.find((part) => part.id === id)
        : component && id === 'root'
          ? component.template
          : undefined;
      // Keep unrelated legacy override fields readable; new vector data needs a real target.
      if (!target) return !containsVector(patch);
      return visit({ ...target, ...patch, vector: patch.vector ?? target.vector }, depth + 1);
    });
  };
  return (
    content.elements.every((e) => visit(e)) &&
    content.components.every((c) => (c.elements ?? []).every((e) => visit(e)))
  );
}

/** Override layouts are partial: each present field must still be valid. */
function validOverrideLayout(layout: Partial<NonNullable<DesignElement['layout']>>): boolean {
  if (typeof layout !== 'object' || Array.isArray(layout)) return false;
  for (const key of ['gap', 'padding'] as const)
    if (layout[key] !== undefined && (!Number.isFinite(layout[key]) || layout[key] < 0))
      return false;
  return (
    optional(layout.direction, oneOf(['row', 'column', 'absolute'])) &&
    optional(layout.align, oneOf(['start', 'center', 'end'])) &&
    optional(layout.sizing, oneOf(['fixed', 'hug']))
  );
}
const overrideStringKeys = [
  'id',
  'name',
  'text',
  'fill',
  'src',
  'parentId',
  'componentId',
  'styleId',
] as const;
function validDesignOverride(raw: unknown, depth: number): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !validVisualStyle(raw)) return false;
  const p = raw as Partial<DesignElement>;
  return (
    p.reference === undefined &&
    optional(p.vector, validDesignVector) &&
    optional(p.interactions, validDesignInteractions) &&
    optional(p.bounds, validBounds) &&
    overrideStringKeys.every((key) => optional(p[key] as unknown, (v) => typeof v === 'string')) &&
    (!p.layout || validOverrideLayout(p.layout)) &&
    optional(p.overrides, (o) => validDesignOverrides(o, depth + 1))
  );
}
function validDesignOverrides(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= 16) return false;
  return Object.values(value).every((raw) => validDesignOverride(raw, depth));
}
export function layoutDesign(d: DesignContent): DesignContent {
  return layoutOwnedDesign(clone(d));
}
export function layoutDesignElements(elements: DesignElement[]): DesignElement[] {
  return layoutOwnedDesign({ schemaVersion: 2, elements: clone(elements), components: [] })
    .elements;
}
/** Offset within the free cross-axis space for a flow layout's alignment. */
const crossAlignOffset = (l: NonNullable<DesignElement['layout']>, free: number) =>
  l.align === 'center' ? free / 2 : l.align === 'end' ? free : 0;
function hugText(child: DesignElement) {
  const font = child.typography?.fontSize ?? 28;
  child.bounds.width = Math.max(20, Math.min(600, child.text.length * font * 0.6 + 8));
  child.bounds.height = font * 1.3 + 8;
}
/** The caller owns every element; layout writes only element geometry. */
function layoutOwnedDesign(
  next: DesignContent,
  index = designGeometryIndex(next.elements),
): DesignContent {
  const parents = next.elements
    .filter((e) => e.layout && e.layout.direction !== 'absolute')
    .reverse();
  for (let pass = 0; pass < Math.min(10, next.elements.length); pass++)
    for (const parent of parents) {
      const l = parent.layout!;
      const children = (index.children.get(parent.id) ?? []).filter((e) => !e.hidden);
      const horizontal = l.direction === 'row',
        axis = horizontal ? 'x' : 'y',
        cross = horizontal ? 'y' : 'x',
        size = horizontal ? 'width' : 'height',
        crossSize = horizontal ? 'height' : 'width';
      const fixed = children
        .filter((e) => e.sizing !== 'fill')
        .reduce((sum, e) => sum + e.bounds[size], 0);
      const fills = children.filter((e) => e.sizing === 'fill').length;
      const fillSize = Math.max(
        1,
        (parent.bounds[size] - 2 * l.padding - l.gap * Math.max(0, children.length - 1) - fixed) /
          Math.max(1, fills),
      );
      let cursor = parent.bounds[axis] + l.padding;
      for (const child of children) {
        const old = { ...child.bounds };
        if (child.sizing === 'fill') child.bounds[size] = fillSize;
        if (child.sizing === 'hug' && child.type === 'text') hugText(child);
        child.bounds[axis] = cursor;
        child.bounds[cross] =
          parent.bounds[cross] +
          l.padding +
          crossAlignOffset(l, parent.bounds[crossSize] - 2 * l.padding - child.bounds[crossSize]);
        const placed = { ...child.bounds };
        child.bounds = old;
        placeDesignElement(index, child.id, placed);
        cursor += child.bounds[size] + l.gap;
      }
      if (l.sizing === 'hug') {
        parent.bounds[size] = Math.max(20, cursor - parent.bounds[axis] - l.gap + l.padding);
        parent.bounds[crossSize] = Math.max(
          20,
          ...children.map((e) => e.bounds[crossSize] + 2 * l.padding),
        );
      }
    }
  return next;
}
export const reparentElement = (id: string, parentId?: string): EditorCommand<DesignContent> =>
  command('design.reparent', 'Move element to frame', (d) => {
    const element = d.elements.find((e) => e.id === id);
    if (!element) throw new Error('Element not found');
    assertEditable(d.elements, [id]);
    if (parentId && (id === parentId || descendantIds(d.elements, [id]).has(parentId)))
      throw new Error('A layer cannot become its own ancestor');
    if (
      parentId &&
      !d.elements.some((e) => e.id === parentId && ['frame', 'group'].includes(e.type))
    )
      throw new Error('Choose a frame or group');
    if (parentId) assertEditable(d.elements, [parentId]);
    return layoutDesign({
      ...d,
      elements: d.elements.map((e) => (e.id === id ? { ...e, parentId } : e)),
    });
  });
export const patchDesign = (
  ids: string[],
  patch: Partial<DesignElement>,
): EditorCommand<DesignContent> => {
  patch = captureDesignData(patch);
  return command('design.properties', 'Edit properties', (d) => {
    for (const id of ids) assertElementChange(d, targetElement(d, id), patch);
    if (!Object.keys(patch).every((key) => ['locked', 'hidden'].includes(key)))
      assertEditable(d.elements, ids);
    return layoutDesign({
      ...d,
      elements: d.elements.map((e) => {
        if (!ids.includes(e.id)) return e;
        if (e.type === 'instance' && ('text' in patch || 'fill' in patch || 'src' in patch))
          return { ...e, overrides: { ...e.overrides, root: { ...e.overrides?.root, ...patch } } };
        const next = patchVisualStyle(e, patch);
        if (next.reference && patch.imageFit !== undefined)
          next.reference = {
            ...next.reference,
            fit: patch.imageFit === 'fill' ? 'cover' : 'contain',
          };
        return next;
      }),
    });
  });
};
interface OverrideEdit {
  d: DesignContent;
  part: string | readonly string[];
  path: readonly string[];
  patch: Partial<DesignElement>;
  stateOnly: boolean;
}
const isPrimitiveInstance = (d: DesignContent, e: DesignElement) =>
  e.type === 'instance' && d.components.some((c) => c.id === e.componentId && !c.elements);
/** Guard each scoped level; a primitive template/root is the leaf and keeps only the wrapper's guard. */
function assertNestedPartEditable(
  edit: OverrideEdit,
  instance: DesignElement,
  component: DesignComponent,
  remaining: readonly string[],
  effective: DesignElement,
) {
  const { d, stateOnly } = edit;
  const key = remaining[0];
  const primitiveRoot =
    stateOnly &&
    remaining.length === 2 &&
    remaining[1] === 'root' &&
    isPrimitiveInstance(d, effective);
  const scope = component.elements?.map((p) =>
    primitiveRoot && p.id === key
      ? {
          ...applyDesignOverride(
            appearance(d, { ...p, componentId: undefined, overrides: undefined }),
            { ...instance.overrides?.[p.id], overrides: undefined },
          ),
          componentId: undefined,
          styleId: undefined,
          overrides: undefined,
        }
      : designPartAppearance(d, p, instance.overrides?.[p.id]),
  ) ?? [effective];
  assertDesignPathEditable(d, scope, key, stateOnly && remaining.length === 1);
}
/** The addressed part: merge the patch into its existing override. */
function leafInstanceOverride(
  edit: OverrideEdit,
  instance: DesignElement,
  key: string,
  effective: DesignElement,
): Partial<DesignElement> {
  const { patch } = edit;
  const previous = instance.overrides?.[key];
  const root = previous?.overrides?.root;
  // A legacy direct edit must update any scoped values that would otherwise
  // mask it. Keep untouched root fields and explicit override-map replacement.
  if (root && isPrimitiveInstance(edit.d, effective) && !Object.hasOwn(patch, 'overrides')) {
    const changed = Object.fromEntries(
      Object.entries(patch).filter(([field]) => Object.hasOwn(root, field)),
    );
    return {
      ...previous,
      ...patch,
      overrides: {
        ...previous.overrides,
        root: applyDesignOverride(root as DesignElement, changed),
      },
    };
  }
  return { ...previous, ...patch };
}
/**
 * A first scoped edit must retain visible legacy direct styling above the
 * definition's inherited root fields. Existing explicit root fields still win.
 */
function scopedIntermediate(
  d: DesignContent,
  instance: DesignElement,
  key: string,
  effective: DesignElement,
): DesignElement {
  if (effective.type !== 'instance')
    rejectDesign('design-target', 'Intermediate component part is not an instance', key);
  const child = targetComponent(d, effective.componentId ?? '');
  if (child.elements) return effective;
  const inheritedRoot = effective.overrides?.root ?? {};
  const direct = Object.fromEntries(
    Object.entries(instance.overrides?.[key] ?? {}).filter(
      ([field]) => field !== 'overrides' && Object.hasOwn(inheritedRoot, field),
    ),
  );
  return {
    ...effective,
    overrides: {
      ...effective.overrides,
      root: applyDesignOverride(
        applyDesignOverride(inheritedRoot as DesignElement, direct),
        instance.overrides?.[key]?.overrides?.root,
      ),
    },
  };
}
/**
 * Native override maps replace inherited maps. Retain their effective siblings
 * so editing a nested label cannot erase another local value.
 */
function nestedInstanceOverride(
  edit: OverrideEdit,
  instance: DesignElement,
  remaining: readonly string[],
): Partial<DesignElement> {
  const { d, part, path } = edit;
  const component = targetComponent(d, instance.componentId ?? '');
  const key = remaining[0];
  const target = componentPart(component, key);
  const effective = applyDesignOverride(target, instance.overrides?.[key]);
  if (typeof part !== 'string' || path.length > 1)
    assertNestedPartEditable(edit, instance, component, remaining, effective);
  if (remaining.length === 1) return leafInstanceOverride(edit, instance, key, effective);
  const next = scopedIntermediate(d, instance, key, effective);
  return {
    ...instance.overrides?.[key],
    overrides: {
      ...next.overrides,
      [remaining[1]]: nestedInstanceOverride(edit, next, remaining.slice(1)),
    },
  };
}
export const overrideInstance = (
  id: string,
  part: string | readonly string[],
  patch: Partial<DesignElement>,
): EditorCommand<DesignContent> => {
  patch = captureDesignData(patch);
  const path = captureDesignData(typeof part === 'string' ? [part] : part);
  if (!Array.isArray(path) || !path.length || path.length > 16)
    rejectDesign('design-target', 'Expected 1–16 component part IDs');
  path.forEach((key) => designId(key, 'partIds'));
  const stateOnly =
    Object.keys(patch).length > 0 &&
    Object.keys(patch).every((key) => ['locked', 'hidden'].includes(key));
  const edit = command('design.override', 'Override component instance', (d) => {
    const e = targetElement(d, id);
    if (e.type !== 'instance')
      rejectDesign('design-target', 'Expected a Design component instance', id);
    const c = targetComponent(d, e.componentId ?? '');
    if (typeof part === 'string') assertEditable(d.elements, [id]);
    else
      assertDesignPathEditable(
        d,
        stateOnly && !c.elements && path.length === 1
          ? d.elements.map((item) =>
              item.id === id ? { ...item, componentId: undefined, overrides: undefined } : item,
            )
          : d.elements,
        id,
      );
    const nested = (instance: DesignElement, remaining: readonly string[]) =>
      nestedInstanceOverride({ d, part, path, patch, stateOnly }, instance, remaining);
    const first = path[0];
    const value = nested(e, path);
    assertElementChange(d, componentPart(c, first), value, c.elements ?? [], !c.elements);
    if (
      c.elements &&
      !validElements(
        c.elements.map((item) =>
          applyDesignOverride(item, item.id === first ? value : e.overrides?.[item.id]),
        ),
      )
    )
      rejectDesign(
        'design-patch',
        'Override would produce invalid component part hierarchy or values',
        first,
      );
    return {
      ...d,
      elements: d.elements.map((e) =>
        e.id === id ? { ...e, overrides: { ...e.overrides, [first]: value } } : e,
      ),
    };
  });
  // The native adapter expands this instance into its qualified definition/style/ancestor graph.
  return withCommandReads(edit, { content: [id] });
};
export const resetInstance = (id: string): EditorCommand<DesignContent> =>
  command('design.reset-instance', 'Reset instance overrides', (d) => {
    const element = targetElement(d, id);
    if (element.type !== 'instance')
      rejectDesign('design-target', 'Expected a Design component instance', id);
    targetComponent(d, element.componentId ?? '');
    assertEditable(d.elements, [id]);
    return { ...d, elements: d.elements.map((e) => (e.id === id ? { ...e, overrides: {} } : e)) };
  });
export const detachInstance = (id: string): EditorCommand<DesignContent> =>
  command('design.detach', 'Detach component instance', (d) => {
    const e = d.elements.find((e) => e.id === id),
      c = d.components.find((c) => c.id === e?.componentId);
    if (!e || !c) return d;
    if (!c.elements)
      return {
        ...d,
        elements: d.elements.map((v) =>
          v.id === id ? { ...appearance(d, e), componentId: undefined, overrides: undefined } : v,
        ),
      };
    const map = new Map(c.elements.map((e) => [e.id, newId('design')]));
    return {
      ...d,
      elements: [
        ...d.elements.filter((x) => x.id !== id),
        { ...e, type: 'group', componentId: undefined, overrides: undefined },
        ...instanceParts(c, e, (partId) => map.get(partId)!),
      ],
    };
  });
export const updateComponentPart = (
  componentId: string,
  partId: string,
  patch: Partial<DesignElement>,
): EditorCommand<DesignContent> => {
  patch = captureDesignData(patch);
  return command('design.definition', 'Edit shared component definition', (d) => {
    const c = targetComponent(d, componentId);
    if (!c.elements)
      rejectDesign(
        'design-target',
        'Use updateComponent for a template-only definition',
        componentId,
      );
    const part = componentPart(c, partId);
    assertEditable(c.elements, [partId]);
    assertElementChange(d, part, patch, c.elements);
    return {
      ...d,
      components: d.components.map((c) =>
        c.id === componentId
          ? { ...c, elements: c.elements?.map((e) => (e.id === partId ? { ...e, ...patch } : e)) }
          : c,
      ),
    };
  });
};
export const arrangeDesign = (
  ids: string[],
  action: string,
  value?: number,
): EditorCommand<DesignContent> =>
  withCommandReads<DesignContent>(
    command('design.arrange', action, (d) => {
      const roots = selectedRoots(d.elements, ids),
        all = descendantIds(
          d.elements,
          roots.map((e) => e.id),
        );
      if (!['unlock', 'show', 'lock', 'hide'].includes(action))
        assertEditable(d.elements, ids, true);
      if (action === 'duplicate') return duplicateElements(ids).apply(d);
      if (action === 'delete') return deleteElements(ids).apply(d);
      if (action === 'group') return groupElements(ids).apply(d);
      if (action === 'ungroup') {
        const groups = d.elements.filter((e) => ids.includes(e.id) && e.type === 'group');
        return {
          ...d,
          elements: d.elements
            .filter((e) => !groups.some((g) => g.id === e.id))
            .map((e) => {
              const group = groups.find((g) => g.id === e.parentId);
              return group ? { ...e, parentId: group.parentId } : e;
            }),
        };
      }
      if (action.startsWith('distribute-') || action.startsWith('gap-')) {
        const m = distributeGeometry(
          d.elements,
          ids,
          action.endsWith('x') ? 'x' : 'y',
          action.startsWith('gap') ? value : undefined,
        );
        return {
          ...d,
          elements: d.elements.map((e) => (m.has(e.id) ? { ...e, bounds: m.get(e.id)! } : e)),
        };
      }
      if (action === 'rotate')
        return transformElements(ids, { dx: 0, dy: 0, dw: 0, dh: 0, rotation: 90 }).apply(d);
      if (action.startsWith('same-')) {
        const targets = matchingSizeBounds(d.elements, ids, action);
        let next = d;
        for (const [id, bounds] of targets) {
          const old = d.elements.find((e) => e.id === id)!.bounds;
          next = transformDesign(next, [id], {
            dx: 0,
            dy: 0,
            dw: bounds.width - old.width,
            dh: bounds.height - old.height,
          });
        }
        return next;
      }
      if (action === 'flip-x' || action === 'flip-y') {
        const mapped = reflectGeometry(d.elements, ids, action === 'flip-x' ? 'x' : 'y');
        return {
          ...d,
          elements: d.elements.map((e) => (mapped.has(e.id) ? { ...e, ...mapped.get(e.id)! } : e)),
        };
      }
      if (['front', 'back', 'forward', 'backward'].includes(action)) {
        const order = reorderedSiblingIds(d.elements, ids, action);
        const byId = new Map(d.elements.map((e) => [e.id, e]));
        let index = 0;
        return {
          ...d,
          elements: d.elements.map((e) =>
            e.parentId === roots[0]?.parentId ? byId.get(order[index++])! : e,
          ),
        };
      }
      return {
        ...d,
        elements: d.elements.map((e) => {
          if (!all.has(e.id)) return e;
          if (action === 'lock' || action === 'unlock') return { ...e, locked: action === 'lock' };
          if (action === 'hide' || action === 'show') return { ...e, hidden: action === 'hide' };
          return e;
        }),
      };
    }),
    action === 'delete'
      ? { content: ['*'] }
      : action === 'duplicate'
        ? { content: ids }
        : { geometry: ids },
  );

/** Explicit fixed preset; optional child fitting is part of this same native edit. */
export function applyFramePreset(
  id: string,
  width: number,
  height: number,
  fitChildren = false,
): EditorCommand<DesignContent> {
  return withCommandReads(
    command('design.frame-preset', 'Apply fixed frame preset', (current: DesignContent) => {
      const frame = current.elements.find((element) => element.id === id);
      if (
        !frame ||
        frame.type !== 'frame' ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
      )
        throw new Error('Choose an existing frame and valid dimensions');
      if (fitChildren && (!frame.layout || frame.layout.direction === 'absolute'))
        throw new Error(
          'Child fitting requires a row or column layout. Use fixed frame size for absolute layouts.',
        );
      return layoutDesign({
        ...current,
        elements: current.elements.map((element) => {
          if (element.id === id)
            return {
              ...element,
              bounds: { ...element.bounds, width, height },
              ...(element.layout
                ? { layout: { ...element.layout, sizing: 'fixed' as const } }
                : {}),
            };
          if (fitChildren && element.parentId === id)
            return {
              ...element,
              bounds: {
                ...element.bounds,
                ...(frame.layout?.direction === 'row'
                  ? { height: Math.max(1, height - frame.layout.padding * 2) }
                  : { width: Math.max(1, width - (frame.layout?.padding ?? 0) * 2) }),
              },
              sizing:
                frame.layout && frame.layout.direction !== 'absolute'
                  ? ('fill' as const)
                  : ('fixed' as const),
            };
          return element;
        }),
      });
    }),
    { content: ['*'] },
  );
}
