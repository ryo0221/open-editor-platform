import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  designDrawings,
  designPaintOrder,
  exportDesignSvg,
  isDesign,
  overrideInstance,
  makeDesignElement,
} from './model';
import {
  nestedTextFixture,
  styledHiddenGeometryFixture,
} from '../../../tests/fixtures/design-nested-text/content';

it('excludes effective hidden elements and their descendants from paint/export geometry', () => {
  const source = deepFreeze(styledHiddenGeometryFixture());
  const native = JSON.stringify(source);
  const painted = designPaintOrder(source);
  expect(painted.filter((e) => !e.hidden).map((e) => e.id)).toEqual(['card']);
  expect(painted.find((e) => e.id === 'other')?.type).toBe('instance');
  for (const ids of [undefined, source.elements.map((e) => e.id)]) {
    const svg = exportDesignSvg(source, ids, { padding: 0 });
    expect(svg).toContain('viewBox="30 30 300 220"');
    expect(svg).toContain('Nested title');
    expect(svg).not.toContain('Hidden primitive');
  }
  expect(JSON.stringify(source)).toBe(native);
});

it('keeps an explicitly visible primitive root visible over a hidden shared style', () => {
  const d = styledHiddenGeometryFixture();
  const primitive = d.elements.find((e) => e.id === 'primitive')!;
  primitive.overrides = { root: { hidden: false } };
  expect(designPaintOrder(d).find((e) => e.id === 'primitive')?.hidden).not.toBe(true);
  expect(exportDesignSvg(d)).toContain('Hidden primitive');
});

it.each(['locked', 'hidden'] as const)(
  'resolves a composite root shared %s before exposing descendants',
  (flag) => {
    const d = nestedTextFixture();
    d.styles = [{ id: 'blocked', name: 'Blocked', appearance: { [flag]: true } }];
    d.elements[0].styleId = 'blocked';
    const source = deepFreeze(d);
    const drawings = designDrawings(source, source.elements[0]);
    if (flag === 'hidden') {
      expect(drawings).toEqual([]);
      expect(exportDesignSvg(source, ['card'])).not.toContain('Nested title');
    } else {
      expect(drawings.some((d) => d.text === 'Nested title')).toBe(true);
      expect(drawings.every((d) => d.instanceText === undefined)).toBe(true);
    }
    expect(designDrawings(source, source.elements[1]).some((d) => d.instanceText)).toBe(true);
    expect(() =>
      overrideInstance('card', ['section', 'title'], { text: 'Lost' }).apply(source),
    ).toThrow(/Unlock/);
    expect(source).toEqual(d);
  },
);

it('uses the same composite root rotation from a shared style or native geometry', () => {
  const direct = nestedTextFixture();
  direct.elements[0].rotation = 90;
  const styled = nestedTextFixture();
  styled.styles = [{ id: 'turn', name: 'Turn', appearance: { rotation: 90 } }];
  styled.elements[0].styleId = 'turn';
  expect(designDrawings(styled, styled.elements[0])).toEqual(
    designDrawings(direct, direct.elements[0]),
  );
});

it.each(['locked', 'hidden'] as const)('respects a styled native ancestor that is %s', (flag) => {
  const d = nestedTextFixture();
  const parent = { ...makeDesignElement('group'), id: 'parent', styleId: 'blocked' };
  d.styles = [{ id: 'blocked', name: 'Blocked', appearance: { [flag]: true } }];
  d.elements[0].parentId = parent.id;
  d.elements.push(parent);
  const source = deepFreeze(d);
  expect(designDrawings(source, source.elements[0]).every((x) => !x.instanceText)).toBe(true);
  expect(() =>
    overrideInstance('card', ['section', 'title'], { text: 'Lost' }).apply(source),
  ).toThrow(/Unlock/);
});

it.each([false, true])(
  'keeps geometry and visibility on the first scoped edit (explicit root: %s)',
  (explicit) => {
    const d = nestedTextFixture();
    delete d.components[0].elements;
    d.components[0].template.text = 'Primitive title';
    d.components[1].elements![0].overrides = {
      root: {
        bounds: { x: 3, y: 4, width: 100, height: 60 },
        rotation: 15,
        flipX: true,
        flipY: true,
        hidden: true,
        locked: true,
        typography: { fontSize: 18, bold: true, italic: true, lineHeight: 1.4 },
      },
    };
    d.elements[0].overrides = {
      section: {
        bounds: { x: 20, y: 30, width: 150, height: 70 },
        rotation: 40,
        flipX: false,
        flipY: false,
        hidden: false,
        locked: false,
        typography: { fontSize: 24 },
        ...(explicit
          ? {
              overrides: {
                root: { bounds: { x: 11, y: 12, width: 130, height: 65 }, rotation: 25 },
              },
            }
          : {}),
      },
    };
    const source = deepFreeze(d);
    const before = designDrawings(source, source.elements[0])[0];
    expect(before.instanceText?.partIds).toEqual(['section', 'root']);
    const session = new EditorSession(source);
    session.execute(
      overrideInstance('card', ['section', 'root'], { text: 'Changed title', runs: undefined }),
    );
    const after = session.content;
    expect(isDesign(after)).toBe(true);
    const drawing = designDrawings(after, after.elements[0])[0];
    for (const field of [
      'bounds',
      'rotation',
      'flipX',
      'flipY',
      'hidden',
      'locked',
      'typography',
    ] as const)
      expect(drawing[field]).toEqual(before[field]);
    expect(drawing.text).toBe('Changed title');
    expect(after.components).toEqual(source.components);
    expect(after.elements[1]).toEqual(source.elements[1]);
    const svg = exportDesignSvg(after, ['card']);
    expect(svg).toContain('Changed');
    expect(svg.match(/transform="[^"]*"/g)).toEqual(
      exportDesignSvg(source, ['card']).match(/transform="[^"]*"/g),
    );
    const roundtrip = JSON.parse(JSON.stringify(after));
    expect(isDesign(roundtrip)).toBe(true);
    expect(designDrawings(roundtrip, roundtrip.elements[0])).toEqual(
      designDrawings(after, after.elements[0]),
    );
    session.undo();
    expect(session.content).toEqual(source);
    session.redo();
    expect(session.content).toEqual(after);
  },
);
