import type { DesignElement } from './model';
/** Optional native metadata; all runtime progress and history belong to the viewer. */
export type DesignPrototypeAction =
  | { type: 'navigate' | 'switch' | 'open-overlay'; frameId: string }
  | { type: 'back' }
  | { type: 'close-overlay' };
export interface DesignInteraction {
  trigger: 'click' | 'tap';
  action: DesignPrototypeAction;
}
export interface DesignFlow {
  id: string;
  name: string;
  frameIds: string[];
}
export interface DesignPrototype {
  schemaVersion: 1;
  startFrameId?: string;
  flows: DesignFlow[];
}
export const designPrototypeLimits = {
  flows: 100,
  steps: 256,
  history: 256,
  overlays: 8,
  instanceDepth: 16,
  diagnosticRoutes: 64,
} as const;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 256;
export function validDesignInteractions(v: unknown): v is DesignInteraction[] {
  return (
    Array.isArray(v) &&
    v.length <= 2 &&
    new Set(v.map((i) => (record(i) ? i.trigger : undefined))).size === v.length &&
    Array.from(v).every(
      (i) =>
        record(i) &&
        keys(i, ['trigger', 'action']) &&
        (i.trigger === 'click' || i.trigger === 'tap') &&
        record(i.action) &&
        keys(i.action, ['type', 'frameId']) &&
        typeof i.action.type === 'string' &&
        (['navigate', 'switch', 'open-overlay'].includes(i.action.type)
          ? identifier(i.action.frameId)
          : ['back', 'close-overlay'].includes(i.action.type) && i.action.frameId === undefined),
    )
  );
}
export function validDesignPrototype(v: unknown): v is DesignPrototype {
  return (
    record(v) &&
    keys(v, ['schemaVersion', 'startFrameId', 'flows']) &&
    v.schemaVersion === 1 &&
    (v.startFrameId === undefined || identifier(v.startFrameId)) &&
    Array.isArray(v.flows) &&
    v.flows.length <= designPrototypeLimits.flows &&
    new Set(v.flows.map((f) => (record(f) ? f.id : undefined))).size === v.flows.length &&
    Array.from(v.flows).every(
      (f) =>
        record(f) &&
        keys(f, ['id', 'name', 'frameIds']) &&
        identifier(f.id) &&
        identifier(f.name) &&
        Array.isArray(f.frameIds) &&
        f.frameIds.length > 0 &&
        f.frameIds.length <= designPrototypeLimits.steps &&
        Array.from(f.frameIds).every(identifier),
    )
  );
}

/** Rewrite only native target references, including overrides, when duplicating frames. */
export function remapDesignInteractionTargets<T extends Partial<DesignElement>>(
  e: T,
  ids: ReadonlyMap<string, string>,
): T {
  return {
    ...e,
    ...(e.interactions
      ? {
          interactions: e.interactions.map((i) => ({
            ...i,
            action:
              'frameId' in i.action
                ? { ...i.action, frameId: ids.get(i.action.frameId) ?? i.action.frameId }
                : i.action,
          })),
        }
      : {}),
    ...(e.overrides
      ? {
          overrides: Object.fromEntries(
            Object.entries(e.overrides).map(([id, p]) => [
              id,
              remapDesignInteractionTargets(p, ids),
            ]),
          ),
        }
      : {}),
  };
}
