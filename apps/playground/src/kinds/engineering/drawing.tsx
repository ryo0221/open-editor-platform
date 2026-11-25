import { lazy, Suspense } from 'react';
import type { DrawingDocument } from '@editor-platform/drawing-core';
import { useEditorDraftPort } from '../editor-draft-port';
import { drawingKind } from '@editor-platform/drawing/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const DrawingHost = lazy(() => import('../../drawing/host'));

function DrawingSurface({ host }: HostSurfaceProps<DrawingDocument>) {
  const session = useEditorDraftPort<DrawingDocument>(host);
  return (
    <Suspense fallback={<p className="empty-state">Loading Drawing…</p>}>
      <DrawingHost
        artifact={host.active}
        record={() => latestRecord(host)}
        records={() => host.recordsRef.current}
        persistRecord={async (record) => !host.shared && (await host.persist(record)) !== false}
        session={session}
        shared={host.shared}
        readOnly={host.readOnly}
        inputs={host.inputs}
        persist={(content) => {
          if (host.shared) return;
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
      />
    </Suspense>
  );
}

export const drawingSurface = hostKind(drawingKind, {
  Surface: DrawingSurface,
  hooks: {
    commentsButton: 'disabled',
    comments: false,
  },
});
