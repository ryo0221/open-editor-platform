import { expect, it } from 'vitest';
import {
  createArtifact,
  commitVersion,
  serializeArtifact,
  deserializeArtifact,
} from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { materializePartStyle } from '@editor-platform/templates';
import { resolveStyle, type TokenSet } from '@editor-platform/reuse-core';
import {
  createDesign,
  makeDesignVector,
  validDesignVector,
  createComponent,
  detachInstance,
  exportDesignSvg,
  designDrawings,
  isDesign,
  updateElement,
  makeDesignElement,
} from '@editor-platform/design/model';
import { checkVector } from '../../../tests/fixtures/design-reuse/content';

it.each([
  '<script>alert(1)</script>',
  'M0 0 L1',
  'L0 0',
  'M0 0 A1 1 0 2 0 4 4',
  'M0 0 A-1 1 0 0 1 4 4',
  'M0 0 L1e999 2',
  'M0 0 L1000001 2',
  'M0 0 Z1',
  'M0,,0',
  'M,0 0',
  'M0 0,',
  'M0 0,L1 1',
])('rejects unsafe or incomplete path data: %s', (path) => {
  const vector = { ...checkVector, paths: [path] };
  expect(validDesignVector(vector)).toBe(false);
  expect(() => makeDesignVector(vector)).toThrow(/Invalid/);
});
it('bounds geometry, input size and provenance across elements, singleton templates and overrides', () => {
  expect(validDesignVector(checkVector)).toBe(true);
  expect(validDesignVector({ ...checkVector, viewBox: { ...checkVector.viewBox, width: 0 } })).toBe(
    false,
  );
  expect(validDesignVector({ ...checkVector, paths: Array(129).fill('M0 0') })).toBe(false);
  expect(validDesignVector({ ...checkVector, paths: ['M0 0' + ' L1 1'.repeat(3300)] })).toBe(false);
  expect(
    validDesignVector({ ...checkVector, paths: Array(8).fill('M0 0' + ' L1 1'.repeat(2000)) }),
  ).toBe(false);
  expect(
    validDesignVector({ ...checkVector, provenance: { ...checkVector.provenance, license: '' } }),
  ).toBe(false);
  const icon = makeDesignVector(checkVector);
  const content = { ...createDesign(), elements: [icon] };
  expect(isDesign(content)).toBe(true);
  expect(isDesign({ ...content, elements: [{ ...icon, type: 'image' }] })).toBe(false);
  const component = createComponent(icon.id).apply(content);
  expect(isDesign(component)).toBe(true);
  const corrupt = { ...checkVector, paths: ['M0 0 L1'] };
  expect(
    isDesign({
      ...component,
      components: component.components.map((c) => ({
        ...c,
        template: { ...c.template, vector: corrupt },
      })),
    }),
  ).toBe(false);
  expect(
    isDesign({
      ...component,
      elements: component.elements.map((e) => ({
        ...e,
        overrides: { root: { vector: corrupt } },
      })),
    }),
  ).toBe(false);
});
it('renders and detaches singleton vectors with inherited colors, transforms and attribution', () => {
  const icon = {
    ...makeDesignVector(checkVector),
    id: 'icon',
    fill: '#123456',
    stroke: '#abcdef',
    bounds: { x: 10, y: 20, width: 48, height: 24 },
    rotation: 90,
    flipX: true,
  };
  const original = { ...createDesign(), elements: [icon] };
  const before = JSON.stringify(original);
  const component = createComponent(icon.id).apply(original);
  expect(isDesign(component)).toBe(true);
  const svg = exportDesignSvg(component);
  expect(svg).toContain('d="M20 6 9 17l-5-5"');
  expect(svg).toContain('fill="#123456" stroke="#abcdef"');
  expect(svg).toContain('rotate(90) scale(-1 1)');
  expect(svg).toContain('translate(22 20) scale(1) translate(0 0)');
  expect(svg).toContain('data-vector-version="1.51.0"');
  const detached = detachInstance(component.elements[0].id).apply(component);
  expect(isDesign(detached)).toBe(true);
  expect(detached.elements[0].vector).toEqual(icon.vector);
  expect(designDrawings(component, component.elements[0])[0].vector).toEqual(checkVector);
  expect(JSON.stringify(original)).toBe(before);
});
it('resolves fill and stroke token bindings on path shapes and preserves local Undo and committed versions', async () => {
  const icon = { ...makeDesignVector(checkVector), id: 'icon' };
  const original = { ...createDesign(), elements: [icon] };
  const tokens: TokenSet = {
    schemaVersion: 1,
    modes: ['light', 'dark'],
    defaultMode: 'light',
    tokens: {
      ink: {
        type: 'color',
        value: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 1 },
        modes: { dark: { colorSpace: 'srgb', components: [1, 1, 1], alpha: 1 } },
      },
    },
  };
  materializePartStyle(
    original,
    'icon',
    resolveStyle(
      {
        schemaVersion: 1,
        domain: 'design',
        bindings: { fill: { token: 'ink' }, stroke: { token: 'ink' } },
      },
      tokens,
      { artifactMode: 'dark' },
    ),
    'Icon',
  );
  expect(exportDesignSvg(original)).toContain('fill="#ffffff" stroke="#ffffff"');
  const artifact = await commitVersion(
    createArtifact('design', 'Vector', original),
    'host',
    'Keep',
  );
  const retained = JSON.stringify(artifact.versions[0]);
  const session = new EditorSession(original);
  session.execute(updateElement('icon', { stroke: '#ff0000' }));
  expect(session.content.elements[0].stroke).toBe('#ff0000');
  session.undo();
  expect(session.content).toEqual(original);
  session.redo();
  artifact.draft.content = session.content;
  const imported = deserializeArtifact(serializeArtifact(artifact));
  expect(isDesign(imported.draft.content)).toBe(true);
  expect(JSON.stringify(imported.versions[0])).toBe(retained);
  expect(imported.draft.content).toEqual(artifact.draft.content);
});
it('uses the platform fallback font while preserving explicit element and run font families', () => {
  const label = {
    ...makeDesignElement('text'),
    text: '日本語 ABC',
    typography: { fontSize: 16, fontFamily: 'Example Serif' },
    runs: [{ text: '日本語 ', style: { fontFamily: 'Example CJK' } }, { text: 'ABC' }],
  };
  const explicit = exportDesignSvg({ ...createDesign(), elements: [label] });
  expect(explicit).toContain('font-family="Example Serif"');
  expect(explicit).toContain('font-family="Example CJK"');
  const fallback = exportDesignSvg({
    ...createDesign(),
    elements: [{ ...label, typography: {}, runs: undefined }],
  });
  expect(fallback).toContain('font-family="Noto Sans CJK JP, sans-serif"');
  expect(fallback).not.toContain('Arial');
});
