import { expect, it } from 'vitest';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import {
  arrangeBoard,
  connectNodes,
  connectorGeometry,
  copyBoard,
  createWhiteboard,
  makeWhiteboardNode,
  pasteBoard,
  type WhiteboardContent,
} from './model';

function boardWithConnectedNodes(): WhiteboardContent {
  const a = {
      ...makeWhiteboardNode('sticky'),
      id: 'a',
      bounds: { x: 100, y: 100, width: 50, height: 50 },
    },
    b = {
      ...makeWhiteboardNode('sticky'),
      id: 'b',
      bounds: { x: 300, y: 100, width: 50, height: 50 },
    };
  const board = { ...createWhiteboard(), nodes: [a, b] };
  return deepFreeze(connectNodes('a', 'b').apply(board));
}

it.each(['duplicate', 'group', 'frame'])(
  'arrange %s creates the same IDs every time it is applied',
  (action) => {
    const board = boardWithConnectedNodes(),
      command = arrangeBoard(['a', 'b'], action);
    const first = command.apply(clone(board));
    expect(command.apply(clone(board))).toEqual(first);
    expect(first.nodes.length).toBeGreaterThan(board.nodes.length);
  },
);

it('pastes a copy offset once and a cut back at its original position', () => {
  const board = boardWithConnectedNodes();
  const pasted = (clipboard: WhiteboardContent) => {
    const next = pasteBoard(clipboard).apply(board);
    return { node: next.nodes.at(-2)!.bounds, connector: next.connectors.at(-1)! };
  };
  const copy = pasted(copyBoard(board, ['a', 'b']));
  expect(copy.node).toMatchObject({ x: 120, y: 120 });
  const source = connectorGeometry(board, board.connectors[0])!;
  expect(copy.connector.fromPoint).toEqual({ x: source.x1 + 20, y: source.y1 + 20 });
  expect(pasted(copyBoard(board, ['a', 'b'], 0)).node).toMatchObject({ x: 100, y: 100 });
  const duplicated = arrangeBoard(['a'], 'duplicate').apply(board);
  expect(duplicated.nodes.at(-1)!.bounds).toMatchObject({ x: 120, y: 120 });
});

it('rejects reapplying duplicate to its own result instead of duplicating IDs', () => {
  const board = boardWithConnectedNodes(),
    command = arrangeBoard(['a', 'b'], 'duplicate');
  expect(() => command.apply(command.apply(clone(board)))).toThrow(/already applied/);
});
