import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deepFreeze } from '@editor-platform/artifact-core';
import { makeWhiteboardNode, type WhiteboardSection } from './model';
import { boardNodeTarget, boardSectionTarget, renderBoardTarget } from './canvas-targets';

function markup(target: Parameters<typeof renderBoardTarget>[0]) {
  return renderToStaticMarkup(createElement('svg', null, renderBoardTarget(target)));
}

it('retains immutable targets while observing order, native changes and transient geometry', () => {
  const node = deepFreeze(makeWhiteboardNode('sticky'));
  const target = boardNodeTarget(node, 0);
  expect(boardNodeTarget(node, 0)).toBe(target);
  expect(boardNodeTarget(node, 1).label).toBe('sticky 2');
  const moved = { ...target, bounds: { ...target.bounds, x: target.bounds.x + 300 }, rotation: 35 };
  const preview = markup(moved);
  expect(preview).toContain(`translate(${moved.bounds.x} ${moved.bounds.y})`);
  expect(preview).toContain('rotate(35');
  expect(markup(target)).not.toContain('rotate(35');
  const changed = deepFreeze({ ...node, text: '新しい本文' });
  expect(markup(boardNodeTarget(changed, 0))).toContain('新しい本文');
  expect(node.bounds.x).toBe(target.bounds.x);
});

it.each([false, true])('observes in-place Host mutations (shallow freeze: %s)', (shallow) => {
  const node = makeWhiteboardNode('sticky');
  if (shallow) Object.freeze(node);
  const before = boardNodeTarget(node, 0);
  node.bounds.x += 70;
  const after = boardNodeTarget(node, 0);
  expect(after).not.toBe(before);
  expect(Object.isFrozen(node.bounds)).toBe(false);
  expect(markup(after)).toContain(`translate(${node.bounds.x} ${node.bounds.y})`);
});

it('updates section titles and zoom-dependent strokes without freezing Host geometry', () => {
  const section: WhiteboardSection = deepFreeze({
    id: 'section',
    title: '計画',
    background: '#fff',
    bounds: { x: 0, y: 0, width: 500, height: 300 },
  });
  const target = boardSectionTarget(section, 1);
  expect(boardSectionTarget(section, 1)).toBe(target);
  const zoomed = boardSectionTarget(section, 2);
  expect(markup(zoomed)).toContain('stroke-width="0.5"');
  const changed = deepFreeze({ ...section, title: '改訂' });
  expect(markup(boardSectionTarget(changed, 2))).toContain('改訂');
  const bounds = { ...section.bounds, x: 60 };
  expect(markup({ ...zoomed, bounds })).toContain('x="74"');
  expect(Object.isFrozen(bounds)).toBe(false);
});
