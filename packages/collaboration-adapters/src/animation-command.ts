import { canonicalEqual } from '@editor-platform/artifact-core';
import {
  copy,
  type Action,
  type DomainCodec,
  type Origin,
  type Snapshot,
} from '@editor-platform/collaboration-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { AnimationContent2, Layer2 } from '@editor-platform/animation-core/v2';
import { canvasTextReplacement, canvasTextValue } from '@editor-platform/canvas-ui/text-engine';
import { EditorState } from 'prosemirror-state';
import { animationPatchAction } from './animation';
import { canvasEngineDocument, canvasTextItem } from './canvas-text';

const equal = canonicalEqual;

type TextLayer2 = Extract<Layer2, { type: 'text' }>;
function existingTextLayers(before: AnimationContent2, after: AnimationContent2) {
  const pairs: { compositionId: string; previous: TextLayer2; updated: TextLayer2 }[] = [];
  const previousLayers = new Map(
    before.compositions.map((c) => [c.id, new Map(c.layers.map((l) => [l.id, l] as const))]),
  );
  for (const composition of after.compositions)
    for (const updated of composition.layers) {
      const previous = previousLayers.get(composition.id)?.get(updated.id);
      if (previous?.type === 'text' && updated.type === 'text')
        pairs.push({ compositionId: composition.id, previous, updated });
    }
  return pairs;
}
function textLayer(content: AnimationContent2, compositionId: string, id: string) {
  const layer = content.compositions
    .find((c) => c.id === compositionId)
    ?.layers.find((l) => l.id === id);
  if (layer?.type !== 'text') throw Error('Missing Animation text');
  return layer;
}

/** Plan one atomic operation in the native text engine's actual style contexts.
 * Context-changing replacements pass through an empty native document: it has no
 * inherited marks to reinterpret. Undo clears the new text, restores its old base,
 * then restores the old text/overrides. No intermediate document is committed.
 * Font prerequisites and ownership/locks still pass ordinary codec validation. */
export function prepareAnimationEditorActions<T>(
  codec: DomainCodec<T>,
  state: Snapshot<T>,
  command: EditorCommand<T>,
): { actions: Action[]; origin: Origin; transactionId?: string } | undefined {
  const before = state.content as AnimationContent2,
    applied = command.apply(
      command.readonlyInput ? state.content : copy(state.content),
    ) as AnimationContent2,
    origin: Origin = command.context?.origin === 'proposal' ? 'proposal' : 'human';
  if (
    !existingTextLayers(before, applied).some(
      ({ previous, updated }) =>
        !equal([previous.text, previous.runs], [updated.text, updated.runs]),
    )
  ) {
    // Without native text replacements both phases reduce to one read-only diff.
    const patch = animationPatchAction(before, applied);
    return patch
      ? { actions: [patch], origin, transactionId: command.context?.transactionId }
      : undefined;
  }
  const after = copy(applied),
    textLayers = existingTextLayers(before, after),
    replacements = textLayers
      .filter(
        ({ previous, updated }) =>
          !equal([previous.text, previous.runs], [updated.text, updated.runs]),
      )
      .map((pair) => ({
        ...pair,
        baseChanged: !equal(
          [pair.previous.fill, pair.previous.fontSize, pair.previous.lineHeight],
          [pair.updated.fill, pair.updated.fontSize, pair.updated.lineHeight],
        ),
        fontPrerequisite: pair.previous.fontAssetId === null && pair.updated.fontAssetId !== null,
      })),
    actions: Action[] = [],
    versions = new Map(Object.entries(state.textVersions ?? {}));
  let working = copy(before);
  const appendText = (
    pair: (typeof replacements)[number],
    text: string,
    runs: TextLayer2['runs'],
  ) => {
    const style = canvasTextItem(codec, working, pair.updated.id).style,
      tr = canvasTextReplacement(
        EditorState.create({ doc: canvasEngineDocument(codec, working, pair.updated.id) }),
        text,
        runs,
        style,
      );
    if (!tr.steps.length) return;
    const version = versions.get(pair.updated.id) ?? 0;
    actions.push({
      type: 'canvas.text-steps',
      target: pair.updated.id,
      payload: { version, steps: tr.steps.map((s) => s.toJSON()) },
    });
    versions.set(pair.updated.id, version + tr.steps.length);
    // Use the same projection as applyCanvasSteps, rather than assuming raw runs
    // survive native normalization. The subsequent phase reads this exact state.
    Object.assign(
      textLayer(working, pair.compositionId, pair.updated.id),
      canvasTextValue(tr.doc, style),
    );
  };
  const appendPatch = (projection: AnimationContent2) => {
    const patch = animationPatchAction(working, projection);
    if (patch) actions.push(patch);
    working = projection;
  };
  for (const pair of replacements) {
    if (pair.baseChanged) appendText(pair, '', []);
    else if (!pair.fontPrerequisite) appendText(pair, pair.updated.text, pair.updated.runs);
  }
  const prerequisites = copy(working);
  for (const { compositionId, updated, baseChanged, fontPrerequisite } of replacements) {
    const layer = textLayer(prerequisites, compositionId, updated.id);
    if (baseChanged) {
      layer.fill = updated.fill;
      layer.fontSize = updated.fontSize;
      layer.lineHeight = updated.lineHeight;
    }
    if (fontPrerequisite) {
      layer.fontAssetId = updated.fontAssetId;
      const asset = after.assets.find((a) => a.id === updated.fontAssetId)!,
        index = prerequisites.assets.findIndex((a) => a.id === asset.id);
      if (index < 0) prerequisites.assets.push(copy(asset));
      else prerequisites.assets[index] = copy(asset);
    }
  }
  appendPatch(prerequisites);
  for (const pair of replacements)
    if (pair.baseChanged || pair.fontPrerequisite)
      appendText(pair, pair.updated.text, pair.updated.runs);
  const metadata = copy(after);
  for (const { compositionId, updated } of textLayers) {
    const projected = textLayer(working, compositionId, updated.id),
      target = textLayer(metadata, compositionId, updated.id);
    target.text = projected.text;
    target.runs = copy(projected.runs);
  }
  // Remaining font removal, locks and input ownership follow native text.
  appendPatch(metadata);
  return actions.length
    ? {
        actions,
        origin,
        transactionId: command.context?.transactionId,
      }
    : undefined;
}
