/** Test-only independent Host; public Surface, real browser input and explicit rejection/retry. */
import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import {
  DesignSurface,
  createDesign,
  makeDesignElement,
  createComponent,
  type DesignContent,
} from '@editor-platform/design';
import '@editor-platform/editor-ui/styles.css';
import { publicationParts, publishDesignComponent } from '@editor-platform/design/publication';

function Host() {
  const [inputs] = useState(() => new EditorInputs());
  const pending = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot);
  const [accept, setAccept] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [session] = useState(() => {
    const native: DesignContent = {
      ...createDesign(),
      elements: [
        {
          ...makeDesignElement('text'),
          id: 'text',
          name: 'Editable',
          text: 'Hello',
          bounds: { x: 60, y: 60, width: 380, height: 100 },
          typography: { bold: true, italic: true, underline: true, strike: true },
        },
      ],
    };
    if (!new URLSearchParams(location.search).has('component')) return new EditorSession(native);
    const created = createComponent('text', 'part-component').apply(native);
    const component = created.components[0];
    return new EditorSession(
      publishDesignComponent(
        created,
        component.id,
        { symbol: 'EditableText', version: '1.0.0', props: {}, variants: {} },
        { [publicationParts(component)[0].id]: 'p' },
      ).apply(created),
    );
  });
  const [, refresh] = useState(0);
  return (
    <EditorInputsContext.Provider value={inputs}>
      <label>
        <input
          type="checkbox"
          aria-label="Host accepts commands"
          checked={accept}
          onChange={(event) => setAccept(event.target.checked)}
        />
        Host accepts commands
      </label>
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          try {
            flushSync(() => inputs.flush());
            setStatus('Accepted');
          } catch {
            setStatus('Rejected; buffer retained');
          }
        }}
      >
        Host flush
      </button>
      <output aria-label="Flush status">{status}</output>
      <output aria-label="Pending input count">{pending.dirty}</output>
      <div style={{ height: 650 }}>
        <DesignSurface
          content={session.content}
          select={() => {}}
          execute={(command) => {
            if (!accept) return false;
            session.execute(command);
            refresh((revision) => revision + 1);
            return true;
          }}
        />
      </div>
      <pre data-testid="design-source">{JSON.stringify(session.content)}</pre>
    </EditorInputsContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
