import { clone, deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import {
  assertEditable,
  command,
  descendantIds,
  rotatedBounds,
  withCommandReads,
  type Bounds,
  type EditorCommand,
  type ElementAddress,
} from '@editor-platform/editor-core';
import {
  appearance,
  designInstanceElements,
  designPaintOrder,
  guardDesignCommand,
  assertDesignInteractionTargets,
  type DesignContent,
  type DesignElement,
} from './model';
import { captureDesignData, rejectDesign } from './command-data';
import {
  designPrototypeLimits,
  validDesignInteractions,
  validDesignPrototype,
  type DesignInteraction,
  type DesignPrototype,
  type DesignPrototypeAction,
} from './prototype-contract';
export * from './prototype-contract';

export interface DesignPrototypeTarget {
  key: string;
  elementId: string;
  partIds: string[];
  name: string;
  bounds: Bounds;
  rotation: number;
  clips: (Bounds & { rotation?: number })[];
  interactions: DesignInteraction[];
}
export interface DesignPrototypeDiagnostic {
  code: 'missing-frame' | 'disconnected-flow' | 'instance-cycle' | 'route-limit';
  path: string;
  message: string;
}
export interface DesignPrototypeState {
  frameId: string;
  overlays: string[];
  history: { frameId: string; overlays: string[] }[];
  flowId?: string;
  flowIndex: number;
  completed: boolean;
}
export interface DesignFlowCompletion {
  flowId: string;
  frameIds: string[];
}
const visibleFrameIndexes = new WeakMap<DesignContent, Map<string, DesignElement>>();
/** Visible frames by ID, remembered only for deep-frozen content. */
function visibleFrames(d: DesignContent) {
  const known = visibleFrameIndexes.get(d);
  if (known) return known;
  const frames = new Map<string, DesignElement>();
  for (const e of designPaintOrder(d))
    if (e.type === 'frame' && !e.hidden && !frames.has(e.id)) frames.set(e.id, e);
  if (isDeepFrozen(d)) visibleFrameIndexes.set(d, frames);
  return frames;
}
const frame = (d: DesignContent, id: string) => visibleFrames(d).get(id);
export const designPrototypeFrameId = (s: DesignPrototypeState) => s.overlays.at(-1) ?? s.frameId;

/** Hidden state and clipping frames inherited from an element's ancestors in one scope. */
function ancestorScope(
  e: DesignElement,
  byId: Map<string, DesignElement>,
  inheritedClips: DesignPrototypeTarget['clips'],
) {
  let parent = e.parentId ? byId.get(e.parentId) : undefined;
  let hidden = !!e.hidden;
  const clips = [...inheritedClips];
  const seen = new Set<string>();
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    hidden ||= !!parent.hidden;
    if (parent.type === 'frame' && parent.clipContent)
      clips.push({ ...parent.bounds, rotation: parent.rotation });
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return { hidden, clips };
}
const overlapsEvery = (box: DesignElement['bounds'], clips: DesignElement['bounds'][]) =>
  clips.every(
    (clip) =>
      box.x < clip.x + clip.width &&
      box.x + box.width > clip.x &&
      box.y < clip.y + clip.height &&
      box.y + box.height > clip.y,
  );
/** Stable scoped keys do not concatenate or parse user IDs. Hidden ancestor subtrees are absent. */
export function designPrototypeTargets(d: DesignContent, frameId: string): DesignPrototypeTarget[] {
  const owner = frame(d, frameId);
  if (!owner) return [];
  const included = descendantIds(d.elements, [frameId]);
  const result: DesignPrototypeTarget[] = [];
  const expand = (
    list: DesignElement[],
    rootId?: string,
    path: string[] = [],
    componentStack: string[] = [],
    originalIds = new Map<string, string>(),
    inheritedClips: DesignPrototypeTarget['clips'] = [],
  ) => {
    const byId = new Map(list.map((e) => [e.id, e]));
    for (const e of designPaintOrder({ ...d, elements: list })) {
      const { hidden, clips } = ancestorScope(e, byId, inheritedClips);
      if (hidden) continue;
      const elementId = rootId ?? e.id;
      const partIds = rootId ? [...path, originalIds.get(e.id) ?? e.id] : [];
      const effective = appearance(d, e);
      const box = rotatedBounds(effective.bounds, effective.rotation);
      if (overlapsEvery(box, [owner.bounds, ...clips.map((c) => rotatedBounds(c, c.rotation))]))
        result.push({
          key: JSON.stringify([elementId, ...partIds]),
          elementId,
          partIds,
          name: e.name,
          bounds: { ...effective.bounds },
          rotation: effective.rotation ?? 0,
          clips,
          interactions: clone(effective.interactions ?? []),
        });
      const component =
        e.type === 'instance' ? d.components.find((c) => c.id === e.componentId) : undefined;
      if (
        !component?.elements ||
        componentStack.includes(component.id) ||
        componentStack.length >= designPrototypeLimits.instanceDepth
      )
        continue;
      // Geometry shares the drawing projection; original part IDs stay in their own scope.
      const idFor = (id: string) => JSON.stringify([elementId, ...partIds, id]);
      const parts = designInstanceElements(d, e, idFor);
      expand(
        parts,
        elementId,
        partIds,
        [...componentStack, component.id],
        new Map(component.elements.map((p) => [idFor(p.id), p.id])),
        clips,
      );
    }
  };
  expand(d.elements.filter((e) => included.has(e.id)));
  return result;
}

export function diagnoseDesignPrototype(input: DesignContent): DesignPrototypeDiagnostic[] {
  // Every simulated action looks frames up; one owned snapshot lets those
  // lookups share an index even when a Host passes mutable content.
  const d = isDeepFrozen(input) ? input : deepFreeze(clone(input));
  const diagnostics: DesignPrototypeDiagnostic[] = [];
  const frames = new Set(
    designPaintOrder(d)
      .filter((e) => e.type === 'frame' && !e.hidden)
      .map((e) => e.id),
  );
  const components = new Map(d.components.map((component) => [component.id, component]));
  // Alternative navigation histories and different flows often inspect the same
  // frame. This cache is scoped to this synchronous diagnosis, never Host identity.
  const targets = new Map<string, DesignPrototypeTarget[]>();
  const frameTargets = (id: string) => {
    let value = targets.get(id);
    if (!value) {
      value = designPrototypeTargets(d, id);
      targets.set(id, value);
    }
    return value;
  };
  const checkFrame = (id: string, path: string) => {
    if (!frames.has(id))
      diagnostics.push({
        code: 'missing-frame',
        path,
        message: `Frame is missing or hidden: ${id}`,
      });
  };
  const interactions = (items: DesignInteraction[] | undefined, path: string) => {
    items?.forEach((i, index) => {
      if ('frameId' in i.action) checkFrame(i.action.frameId, `${path}/${index}/action/frameId`);
    });
  };
  const visit = (e: Partial<DesignElement>, path: string, depth = 0) => {
    interactions(e.interactions, `${path}/interactions`);
    if (depth < designPrototypeLimits.instanceDepth)
      Object.entries(e.overrides ?? {}).forEach(([id, p]) =>
        visit(p, `${path}/overrides/${id}`, depth + 1),
      );
  };
  d.elements.forEach((e) => visit(e, `elements/${e.id}`));
  d.components.forEach((c) => {
    interactions(c.template.interactions, `components/${c.id}/template/interactions`);
    c.elements?.forEach((e) => visit(e, `components/${c.id}/elements/${e.id}`));
  });
  const cycles = (id: string, path: string[], depth: number) => {
    if (path.includes(id) || depth >= designPrototypeLimits.instanceDepth) {
      diagnostics.push({
        code: 'instance-cycle',
        path: `components/${id}`,
        message: 'Component instances contain a cycle or exceed the expansion depth',
      });
      return;
    }
    components.get(id)?.elements?.forEach((e) => {
      if (e.type === 'instance' && e.componentId) cycles(e.componentId, [...path, id], depth + 1);
    });
  };
  d.components.forEach((c) => cycles(c.id, [], 0));
  if (d.prototyping?.startFrameId)
    checkFrame(d.prototyping.startFrameId, 'prototyping/startFrameId');
  d.prototyping?.flows.forEach((flow) => {
    flow.frameIds.forEach((id, i) => checkFrame(id, `prototyping/flows/${flow.id}/frameIds/${i}`));
    let states: DesignPrototypeState[] = [];
    try {
      states = [startDesignPrototype(d, { frameId: flow.frameIds[0] })];
    } catch {
      /* reported above */
    }
    for (let i = 1; i < flow.frameIds.length; i++) {
      const from = flow.frameIds[i - 1],
        to = flow.frameIds[i];
      const reachable: DesignPrototypeState[] = [];
      for (const state of states)
        for (const target of frameTargets(from))
          for (const { action } of target.interactions) {
            try {
              const next = applyDesignPrototypeAction(d, state, action).state;
              if (next !== state && designPrototypeFrameId(next) === to) reachable.push(next);
            } catch {
              /* bad targets are diagnosed independently */
            }
          }
      const unique = new Map(
        reachable.map((s) => [JSON.stringify([s.frameId, s.overlays, s.history]), s]),
      );
      if (unique.size > designPrototypeLimits.diagnosticRoutes) {
        diagnostics.push({
          code: 'route-limit',
          path: `prototyping/flows/${flow.id}`,
          message:
            'Flow has too many alternative navigation histories to diagnose; use a more specific flow',
        });
        break;
      }
      states = [...unique.values()];
      if (!states.length)
        diagnostics.push({
          code: 'disconnected-flow',
          path: `prototyping/flows/${flow.id}/frameIds/${i}`,
          message: `No executable interaction connects ${from} to ${to}`,
        });
    }
  });
  return diagnostics;
}

export function setDesignInteractions(
  elementId: string,
  interactions: DesignInteraction[] | undefined,
  partId?: string,
  definition = false,
): EditorCommand<DesignContent> {
  interactions = captureDesignData(interactions);
  return guardDesignCommand(
    withCommandReads(
      command('design.interactions', 'Edit prototype interaction', (d: DesignContent) => {
        if (interactions !== undefined && !validDesignInteractions(interactions))
          throw new Error('Invalid prototype interactions');
        assertDesignInteractionTargets(d, interactions);
        const e = d.elements.find((e) => e.id === elementId);
        if (!e) throw new Error('Element not found');
        assertEditable(d.elements, [elementId]);
        const c = d.components.find((c) => c.id === e.componentId);
        if (
          partId &&
          (!c || !(c.elements ? c.elements.some((p) => p.id === partId) : partId === 'root'))
        )
          throw new Error('Component part not found');
        const patch = { interactions: clone(interactions) };
        if (partId && definition)
          return {
            ...d,
            components: d.components.map((v) =>
              v.id !== c!.id
                ? v
                : c!.elements
                  ? {
                      ...v,
                      elements: v.elements!.map((p) => (p.id === partId ? { ...p, ...patch } : p)),
                    }
                  : { ...v, template: { ...v.template, ...patch } },
            ),
          };
        return {
          ...d,
          elements: d.elements.map((v) =>
            v.id !== elementId
              ? v
              : partId
                ? {
                    ...v,
                    overrides: { ...v.overrides, [partId]: { ...v.overrides?.[partId], ...patch } },
                  }
                : { ...v, ...patch },
          ),
        };
      }),
      { content: ['*'] },
    ),
  );
}
export function setDesignPrototype(
  prototype: DesignPrototype | undefined,
): EditorCommand<DesignContent> {
  prototype = captureDesignData(prototype);
  return guardDesignCommand(
    withCommandReads(
      command('design.prototype', 'Edit prototype flows', (d: DesignContent) => {
        if (prototype !== undefined && !validDesignPrototype(prototype))
          throw new Error('Invalid prototype flows');
        if (
          prototype &&
          [prototype.startFrameId, ...prototype.flows.flatMap((f) => f.frameIds)].some(
            (id) => id !== undefined && !d.elements.some((e) => e.id === id && e.type === 'frame'),
          )
        )
          rejectDesign(
            'design-prototype-target',
            'Prototype targets must be existing Design frames',
          );
        const next = { ...d };
        if (!prototype || (prototype.startFrameId === undefined && !prototype.flows.length))
          delete next.prototyping;
        else
          next.prototyping = clone({
            schemaVersion: prototype.schemaVersion,
            flows: prototype.flows,
            ...(prototype.startFrameId === undefined
              ? {}
              : { startFrameId: prototype.startFrameId }),
          });
        return next;
      }),
      { content: ['*'] },
    ),
  );
}
export function startDesignPrototype(
  d: DesignContent,
  options: { frameId?: string; flowId?: string } = {},
): DesignPrototypeState {
  const flow = options.flowId
    ? d.prototyping?.flows.find((f) => f.id === options.flowId)
    : undefined;
  if (options.flowId && !flow) throw new Error('Flow not found');
  const id =
    flow?.frameIds[0] ??
    options.frameId ??
    d.prototyping?.startFrameId ??
    designPaintOrder(d).find((e) => e.type === 'frame' && !e.hidden)?.id;
  if (!id || !frame(d, id)) throw new Error('Choose an existing visible start frame');
  return {
    frameId: id,
    overlays: [],
    history: [],
    flowId: flow?.id,
    flowIndex: 0,
    completed: flow?.frameIds.length === 1,
  };
}
function progress(d: DesignContent, before: DesignPrototypeState, next: DesignPrototypeState) {
  const flow = d.prototyping?.flows.find((f) => f.id === next.flowId);
  if (!flow) return { state: next };
  const id = designPrototypeFrameId(next);
  let index = before.flowIndex;
  if (id === flow.frameIds[index + 1]) index++;
  else if (id !== flow.frameIds[index]) {
    const previous = flow.frameIds.slice(0, index).lastIndexOf(id);
    if (previous >= 0) index = previous;
  }
  const completed = before.completed || index === flow.frameIds.length - 1;
  return {
    state: { ...next, flowIndex: index, completed },
    ...(!before.completed && completed
      ? { completion: { flowId: flow.id, frameIds: [...flow.frameIds] } }
      : {}),
  };
}
export function applyDesignPrototypeAction(
  d: DesignContent,
  s: DesignPrototypeState,
  action: DesignPrototypeAction,
): { state: DesignPrototypeState; completion?: DesignFlowCompletion } {
  if ('frameId' in action && !frame(d, action.frameId))
    throw new Error(`Frame is missing or hidden: ${action.frameId}`);
  let next: DesignPrototypeState;
  if (action.type === 'back') {
    const previous = s.history.at(-1);
    if (!previous) return { state: s };
    if (![previous.frameId, ...previous.overlays].every((id) => frame(d, id)))
      throw new Error('A frame in the prototype history was removed');
    next = { ...s, ...clone(previous), history: s.history.slice(0, -1) };
  } else if (action.type === 'close-overlay') {
    if (!s.overlays.length) return { state: s };
    const overlays = s.overlays.slice(0, -1);
    const previous = s.history.at(-1);
    const closesVisit =
      previous?.frameId === s.frameId &&
      previous.overlays.length === overlays.length &&
      previous.overlays.every((id, index) => id === overlays[index]);
    next = { ...s, overlays, history: closesVisit ? s.history.slice(0, -1) : s.history };
  } else {
    if (action.type === 'open-overlay' && s.overlays.length >= designPrototypeLimits.overlays)
      throw new Error('Too many open overlays');
    const history =
      action.type === 'switch'
        ? s.history
        : [...s.history, { frameId: s.frameId, overlays: [...s.overlays] }].slice(
            -designPrototypeLimits.history,
          );
    next =
      action.type === 'open-overlay'
        ? { ...s, overlays: [...s.overlays, action.frameId], history }
        : action.type === 'switch' && s.overlays.length
          ? { ...s, overlays: [...s.overlays.slice(0, -1), action.frameId], history }
          : { ...s, frameId: action.frameId, overlays: [], history };
  }
  return progress(d, s, next);
}
export function activateDesignPrototype(
  d: DesignContent,
  s: DesignPrototypeState,
  targetKey: string,
  trigger: 'click' | 'tap' = 'click',
) {
  const target = designPrototypeTargets(d, designPrototypeFrameId(s)).find(
    (t) => t.key === targetKey,
  );
  const interaction =
    target?.interactions.find((i) => i.trigger === trigger) ?? target?.interactions[0];
  if (!interaction) throw new Error('Prototype interaction not found');
  return applyDesignPrototypeAction(d, s, interaction.action);
}
export function nextDesignPrototypeTargets(d: DesignContent, s: DesignPrototypeState): string[] {
  const flow = d.prototyping?.flows.find((f) => f.id === s.flowId);
  const next = flow?.frameIds[s.flowIndex + 1];
  if (!next) return [];
  return designPrototypeTargets(d, designPrototypeFrameId(s))
    .filter((t) =>
      t.interactions.some((i) => {
        try {
          return designPrototypeFrameId(applyDesignPrototypeAction(d, s, i.action).state) === next;
        } catch {
          return false;
        }
      }),
    )
    .map((t) => t.key);
}
export function designPrototypeAddress(
  artifactId: string,
  target: DesignPrototypeTarget,
): ElementAddress {
  return {
    artifactId,
    elementId: target.elementId,
    ...(target.partIds.length ? { region: { type: 'canvas' as const, ...target.bounds } } : {}),
  };
}
