import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PathHandles } from '@editor-platform/canvas-ui/path-handles';

function Handles() {
  const [events, setEvents] = useState<string[]>([]);
  const record = (value: string) => setEvents((old) => [...old, value]);
  return (
    <>
      <svg width="800" height="500" tabIndex={0}>
        <PathHandles
          points={[{ id: 'point', x: 100, y: 100, kind: 'anchor', label: 'Independent anchor' }]}
          zoom={1}
          selected="point"
          revision="unchanged"
          select={() => {}}
          begin={() => record('begin')}
          preview={() => record('preview')}
          commit={() => record('commit')}
          cancel={() => record('cancel')}
          keyDown={(e) => {
            if (e.key === 'Escape') record('domain escape');
          }}
        />
      </svg>
      <pre data-testid="events">{JSON.stringify(events)}</pre>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Handles />);
