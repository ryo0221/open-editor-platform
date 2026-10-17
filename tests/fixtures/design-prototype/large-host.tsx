import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  DesignSurface,
  makeDesignElement,
  patchDesign,
  type DesignContent,
} from '@editor-platform/design';
import '@editor-platform/editor-ui/styles.css';

const content: DesignContent = {
  schemaVersion: 2,
  elements: [],
  components: Array.from({ length: 89 }, (_, i) => ({
    id: `component-${i}`,
    name: `Component ${i}`,
    width: 320,
    height: 240,
    template: { type: 'rectangle', text: '', fill: '#ffffff' },
    elements: Array.from({ length: 20 }, (_, j) => ({
      ...makeDesignElement(j === 0 ? 'text' : 'rectangle', j),
      id: `part-${j}`,
      name: `Part ${j}`,
      text: j === 0 ? `Reusable component ${i}` : '',
      bounds: { x: (j % 4) * 70, y: Math.floor(j / 4) * 40, width: 60, height: 30 },
    })),
  })),
  prototyping: {
    schemaVersion: 1,
    startFrameId: 'frame-0',
    flows: Array.from({ length: 31 }, (_, i) => ({
      id: `flow-${i}`,
      name: `Flow ${i}`,
      frameIds: [`frame-${i * 3}`],
    })),
  },
};
for (let i = 0; i < 94; i++) {
  const x = (i % 10) * 400,
    y = Math.floor(i / 10) * 340;
  content.elements.push(
    {
      ...makeDesignElement('frame'),
      id: `frame-${i}`,
      name: `Frame ${i}`,
      bounds: { x, y, width: 360, height: 280 },
    },
    {
      ...makeDesignElement('instance'),
      id: `instance-${i}`,
      name: `Instance ${i}`,
      parentId: `frame-${i}`,
      componentId: `component-${i % 89}`,
      bounds: { x: x + 20, y: y + 20, width: 320, height: 240 },
    },
  );
  for (let j = 0; j < 50; j++)
    content.elements.push({
      ...makeDesignElement(j % 5 === 0 ? 'text' : 'rectangle'),
      id: `element-${i}-${j}`,
      name: `Frame ${i} element ${j}`,
      parentId: `frame-${i}`,
      text:
        j % 5 === 0
          ? `Screen ${i}: reusable native content remains editable across prototype navigation.`
          : '',
      bounds: { x: x + (j % 10) * 32, y: y + Math.floor(j / 10) * 48, width: 30, height: 40 },
    });
}
let canvasVisits = 0;
let canvasDraws = 0;
const extension = {
  render: () => {
    canvasDraws++;
    return undefined;
  },
  canvasOwner: () => {
    canvasVisits++;
    return undefined;
  },
};
declare global {
  interface Window {
    designPrototypeProbe: {
      visits(): number;
      draws(): number;
      native(): string;
      stats: { bytes: number; frames: number; components: number; flows: number };
    };
  }
}
function Host() {
  const [session] = useState(() => new EditorSession(content));
  const mutable = new URLSearchParams(location.search).has('mutable');
  const [, refresh] = useState(0);
  const current = mutable ? content : deepFreeze(session.content);
  window.designPrototypeProbe = {
    visits: () => canvasVisits,
    draws: () => canvasDraws,
    native: () => canonicalJson(mutable ? content : session.content),
    stats: {
      bytes: new TextEncoder().encode(JSON.stringify(current)).length,
      frames: 94,
      components: 89,
      flows: 31,
    },
  };
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <button
        onClick={() => {
          if (mutable) content.elements[0].name = 'Updated frame';
          else session.execute(patchDesign(['frame-0'], { name: 'Updated frame' }));
          refresh((value) => value + 1);
        }}
      >
        Host update title
      </button>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DesignSurface
          content={current}
          select={() => {}}
          extension={
            new URLSearchParams(location.search).has('native')
              ? { canvasOwner: extension.canvasOwner }
              : extension
          }
          execute={(command) => {
            session.execute(command);
            refresh((value) => value + 1);
          }}
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
