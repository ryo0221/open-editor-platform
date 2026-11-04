import { describe, expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import {
  nestedTextFixture,
  styledHiddenGeometryFixture,
} from '../../../tests/fixtures/design-nested-text/content';
import { diagnoseDesign, isDesign, type DesignContent } from './model';

const codes = (d: DesignContent) => diagnoseDesign(d).map((x) => `${x.code} ${x.path}`);

describe('diagnoseDesign (#565)', () => {
  it('returns nothing for intact component references, including primitive roots', () => {
    expect(diagnoseDesign(deepFreeze(nestedTextFixture()))).toEqual([]);
    const d = styledHiddenGeometryFixture();
    d.elements[2].overrides = { root: { text: 'Shown' } };
    expect(diagnoseDesign(d)).toEqual([]);
    const nested = nestedTextFixture();
    nested.elements[0].overrides = { section: { overrides: { title: { text: 'Edited' } } } };
    expect(diagnoseDesign(nested)).toEqual([]);
  });

  it('reports an instance whose component is missing that isDesign still admits', () => {
    const d = nestedTextFixture();
    d.elements[0].componentId = 'component-missing-x';
    expect(isDesign(d)).toBe(true);
    expect(diagnoseDesign(d)).toEqual([
      {
        code: 'missing-component',
        path: 'elements/card/componentId',
        message: 'Instance points at a missing component: component-missing-x',
      },
    ]);
  });

  it('reports a nested instance inside a component that points at a missing component', () => {
    const d = nestedTextFixture();
    d.components[1].elements![0].componentId = 'gone';
    expect(isDesign(d)).toBe(true);
    // Reported once at the definition, not once per instance of the outer component.
    expect(codes(d)).toEqual([
      'missing-nested-component components/outer/elements/section/componentId',
    ]);
  });

  it('reports overrides that target parts the component does not have', () => {
    const d = nestedTextFixture();
    d.elements[0].overrides = {
      ghost: { text: 'x' },
      section: { overrides: { title: { text: 'ok' }, lost: { text: 'y' } } },
    };
    d.components[1].elements![0].overrides = { body: {}, missing: { text: 'z' } };
    const p = styledHiddenGeometryFixture();
    p.elements[2].overrides = { title: { text: 'not a primitive part' } };
    expect(isDesign(d)).toBe(true);
    expect(isDesign(p)).toBe(true);
    expect(codes(d)).toEqual([
      'missing-override-part elements/card/overrides/ghost',
      'missing-override-part elements/card/overrides/section/overrides/lost',
      'missing-override-part components/outer/elements/section/overrides/missing',
    ]);
    expect(codes(p)).toEqual(['missing-override-part elements/primitive/overrides/title']);
  });

  it('follows swapped nested components and reports a swap to a missing one', () => {
    const d = nestedTextFixture();
    d.components.push({ ...d.components[0], id: 'alt', elements: [d.components[0].elements![0]] });
    d.elements[0].overrides = { section: { componentId: 'alt', overrides: { body: {} } } };
    d.elements[1].overrides = { section: { componentId: 'nowhere', overrides: { any: {} } } };
    expect(codes(d)).toEqual([
      'missing-override-part elements/card/overrides/section/overrides/body',
      'missing-nested-component elements/other/overrides/section/componentId',
    ]);
  });

  it('checks definition overrides a swapped part inherits against the replacement', () => {
    const d = nestedTextFixture();
    // `alt` has only `title`; the definition's `body` override is inherited by the swap.
    d.components.push({ ...d.components[0], id: 'alt', elements: [d.components[0].elements![0]] });
    d.elements[0].overrides = { section: { componentId: 'alt' } };
    d.elements[1].overrides = { section: { componentId: 'alt', overrides: {} } };
    expect(diagnoseDesign(d)).toEqual([
      {
        code: 'missing-override-part',
        path: 'elements/card/overrides/section/componentId',
        message: 'Inherited override targets a part missing from swapped component alt: body',
      },
    ]);
  });

  it('uses the effective part type from retained type overrides', () => {
    const d = nestedTextFixture();
    d.elements[0].overrides = { section: { type: 'text', componentId: 'gone' } };
    d.elements[1].overrides = {
      section: { overrides: { title: { type: 'instance', componentId: 'gone' } } },
    };
    expect(isDesign(d)).toBe(true);
    expect(codes(d)).toEqual([
      'missing-nested-component elements/other/overrides/section/overrides/title/componentId',
    ]);
  });

  it('stays bounded on self-referencing components', () => {
    const d = nestedTextFixture();
    d.components[1].elements![0].componentId = 'outer';
    let override = {};
    for (let i = 0; i < 40; i++) override = { section: { overrides: override } };
    d.elements[0].overrides = override;
    // The retained `body` override no longer matches; the 40-level chain stops at the native depth.
    expect(codes(d)).toEqual([
      'missing-override-part components/outer/elements/section/overrides/body',
    ]);
  });
});
