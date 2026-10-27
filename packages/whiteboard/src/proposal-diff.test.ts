import { describe, expect, it } from 'vitest';
import { EditorSession, command, reviewProposedCommands } from '@editor-platform/editor-core';
import { makeWhiteboardNode, transformNodes, type WhiteboardContent } from './model';
import { whiteboardProposalDiff } from './proposal-diff';

const content = (): WhiteboardContent => ({
  schemaVersion: 3,
  sections: [],
  nodes: [
    {
      ...makeWhiteboardNode('sticky'),
      id: 'note',
      text: 'Risks',
      bounds: { x: 40, y: 60, width: 160, height: 120 },
    },
    {
      ...makeWhiteboardNode('sticky'),
      id: 'other',
      text: 'Ideas',
      bounds: { x: 300, y: 60, width: 160, height: 120 },
    },
  ],
  connectors: [],
});
const move = () => transformNodes(['note'], { dx: 80, dy: 20, dw: 0, dh: 0 });
const review = (d: WhiteboardContent, commands = [move()]) =>
  reviewProposedCommands(
    { content: d, base: { artifactId: 'board', versionId: 'v1' } },
    { id: 'p', summary: 'Moved the risks note', commands },
    whiteboardProposalDiff,
  );

describe('Whiteboard proposal diff', () => {
  it('reports a move in board pixels that matches the native transform', () => {
    const d = content();
    const result = review(d);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.changes).toEqual([
      {
        domain: 'whiteboard',
        kind: 'move',
        elementId: 'note',
        elementLabel: 'Risks',
        property: 'bounds',
        before: { x: 40, y: 60, width: 160, height: 120 },
        after: { x: 120, y: 80, width: 160, height: 120 },
        units: 'board-px',
      },
    ]);
    const session = new EditorSession(d);
    session.execute(move());
    expect(session.content).toEqual(result.preview.content);
    expect(d).toEqual(content());
  });
  it('tells a resize from a move', () => {
    const result = review(content(), [transformNodes(['note'], { dx: 0, dy: 0, dw: 40, dh: 0 })]);
    expect(result.status === 'ready' && result.changes[0].kind).toBe('resize');
  });
  it('refuses deleted nodes and coordinates without a known unit', () => {
    const d = content();
    expect(review({ ...d, nodes: d.nodes.slice(1) })).toMatchObject({
      status: 'refused',
      reason: 'missing-target',
      elementIds: ['note'],
    });
    const broken = command<WhiteboardContent>('whiteboard.update', 'Move', (c) => ({
      ...c,
      nodes: c.nodes.map((n) =>
        n.id === 'other' ? { ...n, bounds: { ...n.bounds, x: Number.NaN } } : n,
      ),
    }));
    expect(review(d, [broken])).toMatchObject({
      status: 'refused',
      reason: 'unknown-units',
      elementIds: ['other'],
    });
  });
  it('shows the native content of added nodes and checks section bounds', () => {
    const d = content();
    const image = {
      ...makeWhiteboardNode('image'),
      id: 'pic',
      name: 'Logo',
      src: 'data:image/png;base64,AA==',
      bounds: { x: 0, y: 0, width: 40, height: 40 },
    };
    const add = command<WhiteboardContent>('whiteboard.add', 'Add', (c) => ({
      ...c,
      nodes: [...c.nodes, image],
    }));
    const added = review(d, [add]);
    expect(added).toMatchObject({
      status: 'ready',
      changes: [{ kind: 'added', elementId: 'pic', after: { src: image.src }, units: 'board-px' }],
    });
    const removed = review({ ...d, nodes: [...d.nodes, image] }, [
      command<WhiteboardContent>('whiteboard.delete', 'Delete', (c) => ({
        ...c,
        nodes: c.nodes.filter((n) => n.id !== 'pic'),
      })),
    ]);
    expect(removed).toMatchObject({
      status: 'ready',
      changes: [{ kind: 'removed', before: { src: image.src } }],
    });
    const section = {
      id: 'sec',
      title: 'Lane',
      background: '#fff',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    };
    const broken = command<WhiteboardContent>('whiteboard.section', 'Move section', (c) => ({
      ...c,
      sections: c.sections!.map((x) => ({
        ...x,
        bounds: { ...x.bounds, x: Number.POSITIVE_INFINITY },
      })),
    }));
    expect(review({ ...d, sections: [section] }, [broken])).toMatchObject({
      status: 'refused',
      reason: 'unknown-units',
      elementIds: ['sec'],
    });
    const second = { ...section, id: 'sec-2', title: 'Other' };
    const reorder = command<WhiteboardContent>('whiteboard.section', 'Reorder', (c) => ({
      ...c,
      sections: [...c.sections!].reverse(),
    }));
    expect(review({ ...d, sections: [section, second] }, [reorder])).toMatchObject({
      status: 'ready',
      changes: [{ kind: 'order', property: 'sections', after: ['sec-2', 'sec'] }],
    });
    const line = (id: string) =>
      ({ id, from: 'note', to: 'other' }) as WhiteboardContent['connectors'][number];
    const flip = command<WhiteboardContent>('whiteboard.connector', 'Reorder', (c) => ({
      ...c,
      connectors: [...c.connectors].reverse(),
    }));
    expect(review({ ...d, connectors: [line('c1'), line('c2')] }, [flip])).toMatchObject({
      status: 'ready',
      changes: [{ kind: 'order', property: 'connectors', after: ['c2', 'c1'] }],
    });
  });
});
