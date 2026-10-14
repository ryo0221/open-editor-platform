import { expect, it } from 'vitest';
import { defaultDrawingFontFamily } from '@editor-platform/editor-core';
import {
  createWhiteboard,
  makeWhiteboardNode,
  connectNodes,
  isWhiteboard,
  exportBoardSvg,
  createSection,
  type WhiteboardContent,
} from '@editor-platform/whiteboard';

it('uses the common SVG fallback for Japanese Section and connector labels while keeping explicit node fonts', () => {
  let content: WhiteboardContent = {
    ...createWhiteboard(),
    nodes: [
      { ...makeWhiteboardNode('sticky'), id: 'a', typography: { fontFamily: 'Explicit Serif' } },
      {
        ...makeWhiteboardNode('sticky'),
        id: 'b',
        bounds: { x: 300, y: 100, width: 170, height: 120 },
      },
    ],
  };
  content = createSection({ x: 0, y: 0, width: 600, height: 300 }, '調査 <&>', ['a', 'b']).apply(
    content,
  );
  content = connectNodes('a', 'b').apply(content);
  content.connectors[0].label = '次の行動 <&>';
  expect(isWhiteboard(content)).toBe(true);
  const before = JSON.stringify(content);
  const svg = exportBoardSvg(content);
  expect(svg).toContain(`<g font-family="${defaultDrawingFontFamily}">`);
  expect(svg).toContain('font-family="Explicit Serif"');
  expect(svg).toContain('調査 &lt;&amp;&gt;');
  expect(svg).toContain('次の行動 &lt;&amp;&gt;');
  expect(svg).not.toContain('Arial');
  expect(exportBoardSvg(content)).toBe(svg);
  expect(JSON.stringify(content)).toBe(before);
});
