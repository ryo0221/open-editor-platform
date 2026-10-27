import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { hitPathHandle } from './path-handles';
it('hits in CSS pixels independent of world-space units and zoom', () => {
  const points = [{ id: 'a', x: 10, y: 20, label: 'Anchor', kind: 'anchor' as const }];
  for (const zoom of [0.1, 1, 8]) {
    const toScreen = (p: { x: number; y: number }) => ({ x: 40 + p.x * zoom, y: 90 + p.y * zoom }),
      screen = toScreen(points[0]);
    expect(hitPathHandle(points, { x: screen.x + 7, y: screen.y }, toScreen)?.id).toBe('a');
    expect(hitPathHandle(points, { x: screen.x + 9, y: screen.y }, toScreen)).toBeUndefined();
  }
});
it('keeps the public subpath dependency graph independent of Stage, text and domains', () => {
  const source = readFileSync('packages/canvas-ui/src/path-handles.tsx', 'utf8');
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
  expect(imports).toEqual(['react']);
});
