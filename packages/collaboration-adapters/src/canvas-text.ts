import { EditorState } from 'prosemirror-state';
import { collab, receiveTransaction, sendableSteps } from 'prosemirror-collab';
import { Step, Transform } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import {
  canvasTextDocument,
  canvasTextSchema,
  canvasTextValue,
} from '@editor-platform/canvas-ui/text-engine';
import {
  copy,
  fail,
  type Action,
  type Anchor,
  type DomainCodec,
  type Effect,
} from '@editor-platform/collaboration-core';
import type { TextRun, TextStyle } from '@editor-platform/editor-core';
import { slideDrawing, type SlideContent } from '@editor-platform/slide/model';
import { designDrawings, type DesignContent } from '@editor-platform/design/model';
import { whiteboardDrawing, type WhiteboardContent } from '@editor-platform/whiteboard/model';
import { animationLayerLocked2, type AnimationContent2 } from '@editor-platform/animation-core/v2';
interface TextItem {
  id: string;
  text: string;
  runs?: TextRun[];
  locked?: boolean;
}
export function canvasTextItem<T>(
  codec: Pick<DomainCodec<T>, 'domain'>,
  content: T,
  id: string,
): { item: TextItem; key: string; style: TextStyle } {
  const domain = codec.domain;
  if (domain === 'animation') {
    const native = content as AnimationContent2;
    for (const c of native.compositions) {
      const layer = c.layers.find((l) => l.id === id);
      if (layer?.type === 'text')
        return {
          item: {
            id: layer.id,
            get text() {
              return layer.text;
            },
            set text(value) {
              layer.text = value;
            },
            get runs() {
              return layer.runs;
            },
            set runs(value) {
              layer.runs = value ?? [];
            },
            locked:
              animationLayerLocked2(c, id) ||
              c.tracks.some((t) => t.layerId === id && t.property === 'text') ||
              native.publicInputs.some(
                (i) => i.target.layerId === id && i.target.property === 'text',
              ),
          },
          key: `entity:layers@${encodeURIComponent(c.id)}:${encodeURIComponent(id)}`,
          style: { fontSize: layer.fontSize, lineHeight: layer.lineHeight, color: layer.fill },
        };
    }
    fail('target-deleted', 'Animation text layer is missing');
  }
  if (domain === 'slide')
    for (const page of (content as SlideContent).slides) {
      const item = page.objects.find((e) => e.id === id);
      if (item)
        return {
          item,
          key: `entity:objects@${page.id}:${id}`,
          style: slideDrawing(item).typography ?? {},
        };
    }
  const collection = domain === 'design' ? 'elements' : 'nodes';
  const items =
    domain === 'design'
      ? (content as DesignContent).elements
      : domain === 'whiteboard'
        ? (content as WhiteboardContent).nodes
        : [];
  const item = items.find((e) => e.id === id);
  if (!item) fail('target-deleted', 'Canvas text element is missing');
  const style =
    domain === 'design'
      ? designDrawings(content as DesignContent, item as DesignContent['elements'][number])[0]
          ?.typography
      : whiteboardDrawing(item as WhiteboardContent['nodes'][number]).typography;
  return { item, key: `entity:${collection}:${id}`, style: style ?? {} };
}
export function canvasEngineDocument<T>(
  codec: Pick<DomainCodec<T>, 'domain'>,
  content: T,
  id: string,
): PMNode {
  const { item, style } = canvasTextItem(codec, content, id);
  return canvasTextDocument(item.text, item.runs, style);
}
export function applyCanvasSteps<T>(
  codec: DomainCodec<T>,
  content: T,
  action: Action,
  versions: Record<string, number> = {},
): Effect<T> {
  const { item, key, style } = canvasTextItem(codec, content, action.target);
  if (item.locked) fail('unauthorized', 'Canvas text element is locked');
  const steps = action.payload.steps;
  if (action.payload.version !== (versions[action.target] ?? 0))
    fail('resync-required', 'Canvas text engine version changed; rebase pending steps');
  if (!Array.isArray(steps) || !steps.length || steps.length > 2000)
    fail('schema-mismatch', 'Invalid canvas text steps');
  const tr = new Transform(canvasTextDocument(item.text, item.runs, style)),
    inverse: unknown[] = [];
  for (const json of steps) {
    const step = Step.fromJSON(canvasTextSchema, json);
    inverse.unshift(step.invert(tr.doc).toJSON());
    const result = tr.maybeStep(step);
    if (result.failed) fail('invalid-operation', result.failed);
  }
  tr.doc.check();
  Object.assign(item, canvasTextValue(tr.doc, style));
  return {
    content,
    required: [`${key}/id`],
    touched: [`${key}/text`, `${key}/runs`],
    targets: [item.id],
    invalidates:
      codec.domain === 'slide' ? [`entity:pages:${key.split(':')[1].slice(8)}/objects`] : [],
    inverse: [
      {
        type: 'canvas.text-steps',
        target: item.id,
        payload: { version: (versions[item.id] ?? 0) + steps.length, steps: inverse },
      },
    ],
    textSteps: { target: item.id, steps: copy(steps) },
  };
}
export function mapCanvasTextAnchor<T>(
  codec: Pick<DomainCodec<T>, 'domain'>,
  anchor: Anchor,
  content: T,
  action: Action,
): Anchor {
  if (
    anchor.type !== 'canvas-text' ||
    anchor.orphan ||
    action.type !== 'canvas.text-steps' ||
    action.target !== anchor.elementId
  )
    return anchor;
  const tr = new Transform(canvasEngineDocument(codec, content, anchor.elementId));
  for (const json of action.payload.steps as unknown[])
    tr.step(Step.fromJSON(canvasTextSchema, json));
  const from = tr.mapping.mapResult(anchor.from, 1),
    to = tr.mapping.mapResult(anchor.to, -1);
  return {
    ...anchor,
    from: from.pos,
    to: Math.max(from.pos, to.pos),
    orphan: from.deletedAcross && to.deletedAcross,
  };
}

/** Rebase an actor's native canvas text inverse through later steps on the same target. */
export function rebaseCanvasTextInverse<T>(
  codec: DomainCodec<T>,
  event: import('@editor-platform/collaboration-core').Accepted<T>,
  later: import('@editor-platform/collaboration-core').Accepted<T>[],
  current: import('@editor-platform/collaboration-core').Snapshot<T>,
): Action[] {
  if (!event.inverse.length || event.inverse.some((a) => a.type !== 'canvas.text-steps'))
    fail('undo-conflict', 'Mixed text/domain overlap requires review');
  return event.inverse.map((action) => {
    const target = action.target;
    let state = EditorState.create({
      doc: canvasEngineDocument(codec, event.snapshot.content, target),
      plugins: [
        collab({
          version: event.snapshot.textVersions?.[target] ?? 0,
          clientID: 'selective-inverse',
        }),
      ],
    });
    const tr = state.tr;
    for (const json of action.payload.steps as unknown[])
      tr.step(Step.fromJSON(canvasTextSchema, json));
    state = state.apply(tr);
    const steps = later
      .flatMap((e) =>
        e.operation.actions
          .filter((a) => a.type === 'canvas.text-steps' && a.target === target)
          .flatMap((a) => a.payload.steps as unknown[]),
      )
      .map((json) => Step.fromJSON(canvasTextSchema, json));
    state = state.apply(
      receiveTransaction(
        state,
        steps,
        steps.map(() => 'remote'),
      ),
    );
    const inverse = sendableSteps(state);
    if (!inverse) fail('undo-conflict', 'Native inverse no longer applies');
    return {
      type: 'canvas.text-steps',
      target,
      payload: {
        version: current.textVersions?.[target] ?? 0,
        steps: inverse.steps.map((s) => s.toJSON()),
      },
    };
  });
}
