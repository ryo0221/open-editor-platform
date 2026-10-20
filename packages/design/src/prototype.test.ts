import { describe, expect, it } from 'vitest';
import { canonicalJson, clone, deepFreeze } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { prototypeFixture } from '../../../tests/fixtures/design-prototype/content';
import {
  createComponent,
  designDiff,
  updateComponent,
  createDesign,
  deleteElements,
  designDrawings,
  duplicateElements,
  exportDesignSvg,
  isDesign,
  makeDesignElement,
  type DesignContent,
} from './model';
import {
  activateDesignPrototype,
  applyDesignPrototypeAction,
  designPrototypeAddress,
  designPrototypeFrameId,
  designPrototypeTargets,
  diagnoseDesignPrototype,
  nextDesignPrototypeTargets,
  setDesignInteractions,
  setDesignPrototype,
  startDesignPrototype,
} from './prototype';
import { validDesignInteractions, validDesignPrototype } from './prototype-contract';
const key = (d: DesignContent, frame: string, name: string) =>
  designPrototypeTargets(d, frame).find((t) => t.name === name)!.key;

describe('native Design prototypes', () => {
  it('restores absent prototype metadata after edits and omits undefined keys on command writes', () => {
    const original = deepFreeze({
      ...createDesign(),
      elements: [{ ...makeDesignElement('frame'), id: 'Home' }],
    });
    const session = new EditorSession(original);
    session.execute(setDesignPrototype({ schemaVersion: 1, startFrameId: 'Home', flows: [] }));
    expect(session.content.prototyping?.startFrameId).toBe('Home');
    session.execute(setDesignPrototype({ schemaVersion: 1, startFrameId: undefined, flows: [] }));
    expect(session.content).toStrictEqual(original);
    expect(session.content).not.toHaveProperty('prototyping');
    session.undo();
    expect(session.content.prototyping?.startFrameId).toBe('Home');
    session.redo();
    expect(session.content).toStrictEqual(original);
    session.execute(
      setDesignPrototype({
        schemaVersion: 1,
        startFrameId: undefined,
        flows: [{ id: 'f', name: 'Flow', frameIds: ['Home'] }],
      }),
    );
    expect(session.content.prototyping).not.toHaveProperty('startFrameId');
    expect(session.content.prototyping?.flows).toHaveLength(1);
    session.execute(setDesignPrototype(undefined));
    expect(session.content).toStrictEqual(original);
    expect(JSON.parse(JSON.stringify(session.content))).toStrictEqual(original);
  });
  it('roundtrips optional metadata and leaves both legacy schemas unchanged', () => {
    const d = prototypeFixture();
    expect(isDesign(JSON.parse(JSON.stringify(d)))).toBe(true);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    for (const schemaVersion of [1, 2] as const) {
      const old = { ...createDesign(), schemaVersion, elements: [makeDesignElement('frame')] };
      const bytes = canonicalJson(old);
      expect(isDesign(old)).toBe(true);
      expect(canonicalJson(JSON.parse(JSON.stringify(old)))).toBe(bytes);
      expect(old).not.toHaveProperty('prototyping');
    }
  });
  it('rejects malformed actions, duplicate triggers, sparse arrays and bounded metadata', () => {
    for (const value of [
      null,
      [{}],
      [{ trigger: 'hover', action: { type: 'back' } }],
      [{ trigger: 'click', action: { type: 'navigate' } }],
      [{ trigger: 'click', action: { type: 'back', frameId: 'Home' } }],
      new Array(1),
    ])
      expect(validDesignInteractions(value)).toBe(false);
    expect(
      validDesignInteractions([{ trigger: 'click', action: { type: { toString: 'back' } } }]),
    ).toBe(false);
    const interaction = { trigger: 'click', action: { type: 'back' } };
    expect(validDesignInteractions([interaction, interaction])).toBe(false);
    expect(validDesignPrototype({ schemaVersion: 1, flows: new Array(1) })).toBe(false);
    expect(
      validDesignPrototype({
        schemaVersion: 1,
        flows: [{ id: 'f', name: 'f', frameIds: new Array(2) }],
      }),
    ).toBe(false);
    expect(
      validDesignPrototype({
        schemaVersion: 1,
        flows: [{ id: 'f', name: 'f', frameIds: Array(257).fill('Home') }],
      }),
    ).toBe(false);
    const d = prototypeFixture();
    (
      d.elements.find((e) => e.type === 'instance')!.overrides!['button/part'] as unknown as {
        interactions: unknown;
      }
    ).interactions = [{ trigger: 'tap', action: { type: 'script' } }];
    expect(isDesign(d)).toBe(false);
  });
  it('keeps command edits atomic, undoable and guarded by the Host execution boundary', () => {
    const source = deepFreeze(prototypeFixture());
    const s = new EditorSession(source);
    s.execute(setDesignInteractions('next/instance', [], 'button/part'));
    expect(
      designPrototypeTargets(s.content, 'Home').find((t) => t.name === 'Continue')!.interactions,
    ).toEqual([]);
    s.undo();
    expect(s.content).toEqual(source);
    s.redo();
    s.execute(setDesignInteractions('next/instance', undefined, 'button/part'));
    expect(
      designPrototypeTargets(s.content, 'Home').find((t) => t.name === 'Continue')!.interactions[0]
        .action,
    ).toEqual({ type: 'navigate', frameId: 'Done' });
    s.execute(
      setDesignInteractions(
        'next/instance',
        [{ trigger: 'tap', action: { type: 'navigate', frameId: 'Review' } }],
        'button/part',
        true,
      ),
    );
    expect(s.content.components[0].elements![1].interactions![0].trigger).toBe('tap');
    const before = canonicalJson(s.content);
    expect(() => s.execute(setDesignInteractions('missing', []))).toThrow();
    expect(() =>
      s.execute(
        setDesignPrototype({ schemaVersion: 1, flows: [{ id: '', name: '', frameIds: [] }] }),
      ),
    ).toThrow();
    expect(canonicalJson(s.content)).toBe(before);
    const locked = clone(source);
    locked.elements.find((e) => e.type === 'instance')!.locked = true;
    expect(() => setDesignInteractions('next/instance', []).apply(locked)).toThrow();
    expect(canonicalJson(source)).toBe(canonicalJson(prototypeFixture()));
  });
  it('uses the rendered component geometry and scoped addresses, including nested instance parts', () => {
    const d = prototypeFixture();
    const native = d.elements.find((e) => e.type === 'instance')!;
    const target = designPrototypeTargets(d, 'Home').find((t) => t.name === 'Continue')!;
    expect(target.bounds).toEqual(
      designDrawings(d, native).find((e) => e.text === 'Continue')!.bounds,
    );
    expect(target.key).toBe(JSON.stringify(['next/instance', 'button/part']));
    expect(designPrototypeAddress('artifact', target)).toMatchObject({
      artifactId: 'artifact',
      elementId: native.id,
      region: { type: 'canvas', ...target.bounds },
    });
    // A definition root deliberately shares its ID with its canvas instance.
    d.elements.push({
      ...makeDesignElement('instance'),
      id: 'root',
      parentId: 'Home',
      componentId: 'button-component',
    });
    expect(designPrototypeTargets(d, 'Home').filter((t) => t.elementId === 'root')).toHaveLength(3);
    d.components.push({
      id: 'outer',
      name: 'Outer',
      width: 150,
      height: 48,
      template: { type: 'group', text: '', fill: '#fff' },
      elements: [
        {
          ...native,
          id: 'inner',
          parentId: undefined,
          bounds: { x: 0, y: 0, width: 150, height: 48 },
        },
      ],
    });
    d.elements.push({ ...native, id: 'nested', componentId: 'outer', overrides: undefined });
    expect(
      designPrototypeTargets(d, 'Home').find(
        (t) => t.key === JSON.stringify(['nested', 'inner', 'button/part']),
      )!.interactions[0].action,
    ).toEqual({ type: 'navigate', frameId: 'Review' });
  });
  it('runs five frames with switch, overlays, back and one completion without editing history', () => {
    const d = deepFreeze(prototypeFixture()),
      s = new EditorSession(d);
    const bytes = canonicalJson(s.content);
    let state = startDesignPrototype(d, { flowId: 'happy' });
    expect(nextDesignPrototypeTargets(d, state)).toEqual([key(d, 'Home', 'Continue')]);
    state = activateDesignPrototype(d, state, key(d, 'Home', 'Continue'), 'tap').state;
    state = activateDesignPrototype(d, state, key(d, 'Review', 'Show state')).state;
    expect(state.history).toHaveLength(1); // switching state does not add a navigation visit
    expect(applyDesignPrototypeAction(d, state, { type: 'back' }).state.frameId).toBe('Home');
    state = activateDesignPrototype(d, state, key(d, 'State', 'Open dialog')).state;
    expect(designPrototypeFrameId(state)).toBe('Dialog');
    expect(state.frameId).toBe('State');
    state = activateDesignPrototype(d, state, key(d, 'Dialog', 'Close dialog')).state;
    expect(state.flowIndex).toBe(2);
    expect(applyDesignPrototypeAction(d, state, { type: 'back' }).state.frameId).toBe('Home');
    state = activateDesignPrototype(d, state, key(d, 'State', 'Open dialog')).state;
    const switched = applyDesignPrototypeAction(d, state, {
      type: 'switch',
      frameId: 'Done',
    }).state;
    expect(switched.frameId).toBe('State');
    expect(switched.overlays).toEqual(['Done']);
    expect(
      applyDesignPrototypeAction(d, switched, { type: 'close-overlay' }).state.history,
    ).toHaveLength(1);
    const result = activateDesignPrototype(d, state, key(d, 'Dialog', 'Finish'));
    expect(result.completion).toEqual({
      flowId: 'happy',
      frameIds: d.prototyping!.flows[0].frameIds,
    });
    expect(result.state.completed).toBe(true);
    expect(
      applyDesignPrototypeAction(d, result.state, { type: 'navigate', frameId: 'Done' }).completion,
    ).toBeUndefined();
    expect(canonicalJson(s.content)).toBe(bytes);
    expect(s.canUndo).toBe(false);
  });
  it('returns missing targets and executable flow diagnostics, and recovers after deletion Undo', () => {
    const d = prototypeFixture();
    expect(diagnoseDesignPrototype(d)).toEqual([]);
    const s = new EditorSession(d);
    s.execute(deleteElements(['Review']));
    expect(isDesign(s.content)).toBe(true);
    expect(diagnoseDesignPrototype(s.content).map((x) => x.code)).toContain('missing-frame');
    expect(() =>
      activateDesignPrototype(
        s.content,
        startDesignPrototype(s.content),
        key(s.content, 'Home', 'Continue'),
      ),
    ).toThrow('missing');
    s.undo();
    expect(diagnoseDesignPrototype(s.content)).toEqual([]);
    d.prototyping!.flows[0].frameIds = ['Home', 'State'];
    expect(diagnoseDesignPrototype(d).map((x) => x.code)).toEqual(['disconnected-flow']);
    d.prototyping!.flows[0].frameIds = ['Home', 'Review', 'State', 'Home'];
    expect(diagnoseDesignPrototype(d)).toEqual([]); // back after switch returns the actual history
    d.elements.find((e) => e.id === 'Go back')!.interactions = [
      { trigger: 'click', action: { type: 'close-overlay' } },
    ];
    expect(diagnoseDesignPrototype(d).map((x) => x.code)).toEqual(['disconnected-flow']);
  });
  it('remaps internal frame links on duplication and keeps graphics identical', () => {
    const d = prototypeFixture();
    const noMetadata = clone(d);
    delete noMetadata.prototyping;
    for (const e of noMetadata.elements) {
      delete e.interactions;
      if (e.overrides) for (const p of Object.values(e.overrides)) delete p.interactions;
    }
    for (const c of noMetadata.components) for (const p of c.elements ?? []) delete p.interactions;
    expect(exportDesignSvg(d)).toBe(exportDesignSvg(noMetadata));
    const next = duplicateElements(['Home', 'Review']).apply(d);
    const review = next.elements.find((e) => e.name === 'Review copy')!;
    const home = next.elements.find((e) => e.name === 'Home copy')!;
    expect(
      designPrototypeTargets(next, home.id).find((t) => t.name === 'Continue')!.interactions[0]
        .action,
    ).toEqual({ type: 'navigate', frameId: review.id });
    const single = {
      ...createDesign(),
      elements: [
        {
          ...makeDesignElement('rectangle'),
          interactions: [
            { trigger: 'click' as const, action: { type: 'navigate' as const, frameId: 'target' } },
          ],
        },
      ],
    };
    const made = createComponent(single.elements[0].id).apply(single);
    expect(made.components[0].template.interactions).toEqual(single.elements[0].interactions);
    const updated = updateComponent(made.components[0].id, {
      interactions: [{ trigger: 'click', action: { type: 'back' } }],
    }).apply(made);
    expect(
      designPrototypeTargets(
        {
          ...updated,
          elements: [
            { ...makeDesignElement('frame'), id: 'f' },
            { ...updated.elements[0], parentId: 'f' },
          ],
        },
        'f',
      ).find((t) => t.elementId === updated.elements[0].id)!.interactions[0].action,
    ).toEqual({ type: 'back' });
    expect(
      designDiff(noMetadata, d).changes.some((change) => change.path.includes('Prototype flow')),
    ).toBe(true);
  });
  it('excludes hidden ancestor parts and bounds recursive component expansion', () => {
    const d = prototypeFixture();
    d.components[0].elements![0].hidden = true;
    expect(designPrototypeTargets(d, 'Home').some((t) => t.name === 'Continue')).toBe(false);
    d.components[0].elements!.push({
      ...makeDesignElement('instance'),
      componentId: 'button-component',
    });
    expect(diagnoseDesignPrototype(d).some((x) => x.code === 'instance-cycle')).toBe(true);
    expect(designPrototypeTargets(d, 'Home').length).toBeLessThan(10);
  });
});

it('preserves immutable version bytes and hashes when adding prototype metadata to a legacy draft', async () => {
  const { createArtifact, commitVersion, updateDraft, serializeArtifact, deserializeArtifact } =
    await import('@editor-platform/artifact-core');
  const old = {
    ...createDesign(),
    schemaVersion: 1 as const,
    elements: [makeDesignElement('frame')],
  };
  let artifact = await commitVersion(
    createArtifact<DesignContent>('design', 'Legacy', old),
    null,
    'Original',
  );
  const version = canonicalJson(artifact.versions[0]);
  artifact = updateDraft(
    artifact,
    setDesignPrototype({ schemaVersion: 1, startFrameId: old.elements[0].id, flows: [] }).apply(
      artifact.draft.content,
    ),
  );
  const reloaded = deserializeArtifact(serializeArtifact(artifact));
  expect(canonicalJson(reloaded.versions[0])).toBe(version);
  expect((reloaded.draft.content as DesignContent).prototyping!.startFrameId).toBe(
    old.elements[0].id,
  );
});

it('bounds overlays/history and reports indeterminate branching routes instead of false disconnections', () => {
  const d = prototypeFixture();
  let state = startDesignPrototype(d);
  for (let i = 0; i < 260; i++)
    state = applyDesignPrototypeAction(d, state, { type: 'navigate', frameId: 'Home' }).state;
  expect(state.history).toHaveLength(256);
  for (let i = 0; i < 8; i++)
    state = applyDesignPrototypeAction(d, state, { type: 'open-overlay', frameId: 'Dialog' }).state;
  const bytes = canonicalJson(state);
  expect(() =>
    applyDesignPrototypeAction(d, state, { type: 'open-overlay', frameId: 'Dialog' }),
  ).toThrow('Too many');
  expect(canonicalJson(state)).toBe(bytes);
  d.elements.find((e) => e.id === 'No link')!.interactions = [
    { trigger: 'click', action: { type: 'navigate', frameId: 'Home' } },
    { trigger: 'tap', action: { type: 'open-overlay', frameId: 'Home' } },
  ];
  d.prototyping!.flows = [{ id: 'branch', name: 'Branching', frameIds: Array(10).fill('Home') }];
  expect(diagnoseDesignPrototype(d).map((x) => x.code)).toEqual(['route-limit']);
  d.elements.find((e) => e.id === 'No link')!.bounds.x = 2000;
  expect(designPrototypeTargets(d, 'Home').some((t) => t.name === 'No link')).toBe(false);
});
