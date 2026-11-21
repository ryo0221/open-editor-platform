import { lazy, Suspense } from 'react';
import type { DrawingDocument } from '@editor-platform/drawing-core';
import type { EditorSession } from '@editor-platform/editor-core';
import { drawingKind } from '@editor-platform/drawing/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const DrawingHost = lazy(() => import('../../drawing/host'));

function DrawingSurface({ host }: HostSurfaceProps<DrawingDocument>) {
  return (
    <Suspense fallback={<p className="empty-state">Loading Drawing…</p>}>
      <DrawingHost
        artifact={host.active}
        record={() => latestRecord(host)}
        records={() => host.recordsRef.current}
        persistRecord={async (record) => (await host.persist(record)) !== false}
        session={
          host.sessions.current.get(host.active.id) as unknown as EditorSession<DrawingDocument>
        }
        readOnly={host.readOnly}
        inputs={host.inputs}
        persist={(content) => {
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
      />
    </Suspense>
  );
}

export const drawingSurface = hostKind(drawingKind, { Surface: DrawingSurface, session: 'local' });
