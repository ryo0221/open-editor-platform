import { sameLocalRevision, transaction, type EditorCommand } from '@editor-platform/editor-core';
import {
  readAnimationV1,
  AnimationError,
  putRectangleLayerV1,
  replaceTrack,
  type AnimationContent,
  type Property,
  type Easing,
} from '@editor-platform/animation-core';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type { PreparedSurfaceCommand } from '@editor-platform/extension-contract/controlled-surface';
export const controlledProperties = ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity'] as const;
export type ControlledProperty = (typeof controlledProperties)[number];
export interface AnimationInputDraft {
  base: LocalReadSnapshot<AnimationContent>;
  compositionId: string;
  layerId: string;
  transform: Partial<Record<ControlledProperty, string>>;
  key?: {
    trackId: string;
    keyId: string;
    tick: string;
    value: string;
    easing?: { type: Easing['type']; points: string[] };
  };
  composing: Set<string>;
}
export function hasDraft(d: AnimationInputDraft | null): boolean {
  return !!d && (Object.keys(d.transform).length > 0 || !!d.key || d.composing.size > 0);
}
export class AnimationInputFieldError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
  }
}
function number(raw: string, label: string, field = label): number {
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()))
    throw new AnimationInputFieldError(field, `${label}: enter a complete number`);
  const n = Number(raw);
  if (!Number.isFinite(n))
    throw new AnimationInputFieldError(field, `${label}: enter a finite number`);
  return n;
}
/** Pure aggregate preparation. Host is the only executor/history owner. */
export function prepareAnimationInputs(
  d: AnimationInputDraft | null,
  snapshot: LocalReadSnapshot<AnimationContent>,
  canEdit: () => boolean,
): PreparedSurfaceCommand<AnimationContent> {
  if (!d) return { baseRevision: snapshot.revision, command: null };
  if (d.composing.size) throw new Error('Finish IME composition before applying or saving');
  if (
    !sameLocalRevision(d.base.revision, snapshot.revision) ||
    d.base.scope.artifactId !== snapshot.scope.artifactId ||
    d.base.scope.sessionId !== snapshot.scope.sessionId ||
    d.base.scope.generation !== snapshot.scope.generation
  )
    throw new Error('Input is stale; cancel and re-enter against the current revision');
  let working: AnimationContent = readAnimationV1(snapshot.content);
  const c = working.compositions.find((c) => c.id === d.compositionId),
    layer = c?.layers.find((l) => l.id === d.layerId);
  if (!c || !layer) throw new Error('Input target is unavailable');
  const commands: EditorCommand<AnimationContent>[] = [];
  const append = (command: EditorCommand<AnimationContent>) => {
    working = command.apply(working);
    commands.push(command);
  };
  const scope = { canEdit };
  const transform = { ...layer.transform };
  let changed = false;
  for (const [property, raw] of Object.entries(d.transform)) {
    const p = property as Property;
    const value = number(raw!, `Base ${p}`, p);
    if (transform[p] !== value) {
      transform[p] = value;
      changed = true;
    }
  }
  if (changed) {
    try {
      append(putRectangleLayerV1(working, c.id, { ...layer, transform }, scope));
    } catch (error) {
      if (error instanceof AnimationError && controlledProperties.some((p) => p === error.address))
        throw new AnimationInputFieldError(
          error.address,
          `Base ${error.address}: ${error.message}`,
        );
      throw error;
    }
  }
  if (d.key) {
    const draft = d.key;
    const current = working.compositions
      .find((v) => v.id === c.id)!
      .tracks.find((t) => t.id === draft.trackId);
    const key = current?.keys.find((k) => k.id === draft.keyId);
    if (!current || !key || current.layerId !== layer.id)
      throw new Error('Selected key is unavailable');
    const tick = number(draft.tick, 'Key tick', 'key-tick'),
      value = number(draft.value, 'Key value', 'key-value');
    if (!Number.isSafeInteger(tick) || tick < 0 || tick > c.duration)
      throw new AnimationInputFieldError(
        'key-tick',
        'Key tick must be an integer within composition range',
      );
    if (current.keys.some((k) => k.id !== key.id && k.tick === tick))
      throw new AnimationInputFieldError('key-tick', 'Key tick: A key already exists at that tick');
    const easing: Easing = draft.easing
      ? draft.easing.type === 'bezier'
        ? (() => {
            const names = ['x1', 'y1', 'x2', 'y2'];
            const values = draft.easing!.points.map((raw, i) => {
              const value = number(raw, `Bezier ${names[i]}`, `easing-${names[i]}`);
              if (value < 0 || value > 1)
                throw new AnimationInputFieldError(
                  `easing-${names[i]}`,
                  `Bezier ${names[i]} must be from 0 to 1`,
                );
              return value;
            });
            if (values.length !== 4) throw new Error('Bezier requires four control points');
            return {
              type: 'bezier' as const,
              x1: values[0],
              y1: values[1],
              x2: values[2],
              y2: values[3],
            };
          })()
        : { type: draft.easing.type }
      : key.easing;
    const sameEasing =
      easing.type === key.easing.type &&
      (easing.type !== 'bezier' ||
        (key.easing.type === 'bezier' &&
          easing.x1 === key.easing.x1 &&
          easing.y1 === key.easing.y1 &&
          easing.x2 === key.easing.x2 &&
          easing.y2 === key.easing.y2));
    if (key.tick !== tick || key.value !== value || !sameEasing) {
      const next = structuredClone(current);
      Object.assign(next.keys.find((k) => k.id === key.id)!, { tick, value, easing });
      next.keys.sort((a, b) => a.tick - b.tick);
      try {
        append(replaceTrack(working, c.id, next, scope));
      } catch (error) {
        if (error instanceof AnimationError && error.address === key.id)
          throw new AnimationInputFieldError('key-value', `Key value: ${error.message}`);
        throw error;
      }
    }
  }
  return {
    baseRevision: d.base.revision,
    command: commands.length ? transaction('Apply Animation inputs', commands) : null,
  };
}
