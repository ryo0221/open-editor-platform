import { expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import type { AnimationContent } from '@editor-platform/animation-core';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import { prepareAnimationInputs, type AnimationInputDraft } from './controlled-buffer';
import { controlledFixture } from '../tests/controlled/data';
function setup() {
  const session = new EditorSession<AnimationContent>(controlledFixture());
  const snapshot = (): LocalReadSnapshot<AnimationContent> => ({
    scope: { artifactId: 'a', sessionId: 's', generation: 'g' },
    revision: session.revision,
    content: session.content,
  });
  const base = snapshot();
  const draft: AnimationInputDraft = {
    base,
    compositionId: 'root',
    layerId: 'box',
    transform: { y: '160' },
    key: { trackId: 'x-track', keyId: 'b', tick: '720000', value: '500' },
    composing: new Set(),
  };
  return { session, snapshot, draft };
}
it('chains expected snapshots into one atomic history entry without executing during prepare', () => {
  const { session, snapshot, draft } = setup();
  const before = session.content;
  const prepared = prepareAnimationInputs(draft, snapshot(), () => true);
  expect(session.content).toEqual(before);
  expect(session.canUndo).toBe(false);
  expect(draft.transform.y).toBe('160');
  session.execute(prepared.command!);
  expect(session.content.compositions[0].layers[0].transform.y).toBe(160);
  expect(session.content.compositions[0].tracks[0].keys[1]).toMatchObject({
    tick: 720000,
    value: 500,
  });
  session.undo();
  expect(session.content).toEqual(before);
  expect(session.canUndo).toBe(false);
});
it('invalid second edit, stale revision, IME and lost authority cannot partially apply', () => {
  const { session, snapshot, draft } = setup();
  const before = session.content;
  draft.key!.tick = '0';
  expect(() => prepareAnimationInputs(draft, snapshot(), () => true)).toThrow('already exists');
  expect(session.content).toEqual(before);
  expect(session.canUndo).toBe(false);
  draft.key!.tick = '720000';
  expect(() =>
    prepareAnimationInputs(
      draft,
      { ...snapshot(), revision: { ...snapshot().revision, sequence: 1 } },
      () => true,
    ),
  ).toThrow('stale');
  draft.composing.add('y');
  expect(() => prepareAnimationInputs(draft, snapshot(), () => true)).toThrow('IME');
  draft.composing.clear();
  let edit = true;
  const prepared = prepareAnimationInputs(draft, snapshot(), () => edit);
  edit = false;
  expect(() => session.execute(prepared.command!)).toThrow('read-only');
  expect(session.content).toEqual(before);
});
it('valid no-op returns null and incomplete/invalid raw numbers are never coerced to zero', () => {
  const { snapshot, draft } = setup();
  draft.transform = { y: '140' };
  draft.key = { trackId: 'x-track', keyId: 'b', tick: '960000', value: '400' };
  expect(prepareAnimationInputs(draft, snapshot(), () => true).command).toBeNull();
  for (const raw of ['', '-', '1.', 'NaN', 'Infinity', '0x20']) {
    draft.transform.y = raw;
    expect(() => prepareAnimationInputs(draft, snapshot(), () => true)).toThrow();
  }
  draft.transform.y = '-12.5';
  expect(prepareAnimationInputs(draft, snapshot(), () => true).command).not.toBeNull();
});

it('easing and key/transform edits prepare atomically; invalid easing keeps all native values', () => {
  const { session, snapshot, draft } = setup();
  const before = session.content;
  draft.key!.easing = { type: 'bezier', points: ['0.25', '-', '0.75', '1'] };
  expect(() => prepareAnimationInputs(draft, snapshot(), () => true)).toThrow('complete number');
  expect(session.content).toEqual(before);
  draft.key!.easing.points[1] = '0';
  session.execute(prepareAnimationInputs(draft, snapshot(), () => true).command!);
  expect(session.content.compositions[0].tracks[0].keys[1].easing).toEqual({
    type: 'bezier',
    x1: 0.25,
    y1: 0,
    x2: 0.75,
    y2: 1,
  });
  session.undo();
  expect(session.content).toEqual(before);
  expect(session.canUndo).toBe(false);
});
it('same easing is a semantic no-op and does not consume Redo', () => {
  const { session, snapshot, draft } = setup();
  session.execute(prepareAnimationInputs(draft, snapshot(), () => true).command!);
  session.undo();
  draft.base = snapshot();
  draft.transform = {};
  draft.key = {
    trackId: 'x-track',
    keyId: 'b',
    tick: '960000',
    value: '400',
    easing: { type: 'linear', points: ['0.42', '0', '0.58', '1'] },
  };
  expect(prepareAnimationInputs(draft, snapshot(), () => true).command).toBeNull();
  expect(session.canRedo).toBe(true);
});

it('addresses parser, collision and Core range failures without changing draft or native content', () => {
  const { session, snapshot, draft } = setup();
  const scenarios = [
    {
      field: 'key-tick',
      change: () => {
        draft.key!.tick = '0';
      },
    },
    {
      field: 'easing-y2',
      change: () => {
        draft.key!.easing = { type: 'bezier', points: ['0.25', '0', '0.75', '-'] };
      },
    },
    {
      field: 'opacity',
      change: () => {
        draft.transform.opacity = '2';
      },
    },
    {
      field: 'key-value',
      change: () => {
        draft.key!.value = '1000001';
      },
    },
  ];
  const original = structuredClone(draft);
  for (const scenario of scenarios) {
    Object.assign(draft, structuredClone(original));
    scenario.change();
    const pending = structuredClone(draft);
    let failure: unknown;
    try {
      prepareAnimationInputs(draft, snapshot(), () => true);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ field: scenario.field });
    expect(draft).toEqual(pending);
    expect(session.canUndo).toBe(false);
    expect(session.content).toEqual(original.base.content);
  }
});
