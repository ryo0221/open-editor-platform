import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { makeDesignElement } from './model';
import {
  applyDesignPrototypeAction,
  designPrototypeTargets,
  diagnoseDesignPrototype,
  startDesignPrototype,
} from './prototype';
import { prototypeFixture } from '../../../tests/fixtures/design-prototype/content';

it.each(['frame', 'ancestor'])(
  'rejects starts, navigation and history through a styled hidden %s',
  (owner) => {
    const d = prototypeFixture();
    const hidden = d.elements.find((e) => e.id === 'Review')!;
    d.styles = [{ id: 'hide', name: 'Hidden', appearance: { hidden: true } }];
    if (owner === 'frame') hidden.styleId = 'hide';
    else {
      d.elements.push({ ...makeDesignElement('group'), id: 'hidden-parent', styleId: 'hide' });
      hidden.parentId = 'hidden-parent';
    }
    const source = deepFreeze(d);
    expect(designPrototypeTargets(source, 'Review')).toEqual([]);
    expect(() => startDesignPrototype(source, { frameId: 'Review' })).toThrow(/visible/);
    const state = startDesignPrototype(source, { frameId: 'Home' });
    for (const type of ['navigate', 'switch', 'open-overlay'] as const)
      expect(() => applyDesignPrototypeAction(source, state, { type, frameId: 'Review' })).toThrow(
        /missing or hidden/,
      );
    expect(() =>
      applyDesignPrototypeAction(
        source,
        { ...state, history: [{ frameId: 'Review', overlays: [] }] },
        { type: 'back' },
      ),
    ).toThrow();
    expect(diagnoseDesignPrototype(source)).toContainEqual(
      expect.objectContaining({
        code: 'missing-frame',
        message: 'Frame is missing or hidden: Review',
      }),
    );
    expect(source).toEqual(d);
  },
);

it('chooses the first effectively visible frame when no start is configured', () => {
  const d = prototypeFixture();
  delete d.prototyping;
  d.styles = [{ id: 'hide', name: 'Hidden', appearance: { hidden: true } }];
  d.elements.find((e) => e.id === 'Home')!.styleId = 'hide';
  expect(startDesignPrototype(d).frameId).toBe('Review');
});
