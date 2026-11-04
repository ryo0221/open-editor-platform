import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorSession } from '@editor-platform/editor-core';
import { WhiteboardSurface, type WhiteboardInteractionMode } from '@editor-platform/whiteboard';
import { makeWhiteboardNode, type WhiteboardContent } from '@editor-platform/whiteboard/model';

const initial: WhiteboardContent = {
  schemaVersion: 3,
  sections: [],
  nodes: [
    {
      ...makeWhiteboardNode('shape'),
      id: 'panel',
      shape: 'rectangle',
      bounds: { x: 40, y: 40, width: 240, height: 150 },
      text: '',
    },
  ],
  connectors: [],
};
function Fixture() {
  const [session] = useState(() => new EditorSession(initial));
  const [content, setContent] = useState(session.content);
  const [mode, setMode] = useState<WhiteboardInteractionMode>('content');
  const [counter, setCounter] = useState(0);
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <nav>
        <button onClick={() => setMode('layout')}>配置モード</button>
        <button onClick={() => setMode('content')}>内容モード</button>
        <button disabled={!session.canUndo} onClick={() => setContent(session.undo())}>
          Undo fixture
        </button>
        <output data-testid="counter">{counter}</output>
        <output data-testid="history">{String(session.canUndo)}</output>
      </nav>
      <output hidden data-testid="native">
        {JSON.stringify(content)}
      </output>
      <div style={{ minHeight: 0, flex: 1 }}>
        <WhiteboardSurface
          content={content}
          select={() => undefined}
          execute={(command) => {
            setContent(session.execute(command));
            return true;
          }}
          interactionMode={mode}
          layout={{ viewKey: 'surface-fixture', defaultPanels: { left: false, right: false } }}
          renderNodeContent={({ node, size }) =>
            node.id === 'panel' ? (
              <g>
                <rect width={size.width} height={size.height} fill="#eef4ff" />
                <g
                  role="button"
                  aria-label="時点を進める"
                  tabIndex={0}
                  onClick={() => setCounter((n) => n + 1)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.stopPropagation();
                      setCounter((n) => n + 1);
                    }
                  }}
                >
                  <rect x={20} y={25} width={160} height={65} fill="#4164ad" />
                  <text x={30} y={65} fill="white">
                    時点 {counter}
                  </text>
                </g>
              </g>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
