import { lazy, Suspense } from 'react';
import type { PcbDocument } from '@editor-platform/pcb-core';
import type { EditorSession } from '@editor-platform/editor-core';
import { pcbKind } from '@editor-platform/pcb/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const PcbHost = lazy(() => import('../../pcb/host'));

function PcbSurface({ host }: HostSurfaceProps<PcbDocument>) {
  return (
    <Suspense fallback={<p className="empty-state">Loading Circuit board…</p>}>
      <PcbHost
        artifact={host.active}
        session={host.sessions.current.get(host.active.id) as unknown as EditorSession<PcbDocument>}
        readOnly={host.readOnly}
        inputs={host.inputs}
        persist={(content) => {
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
        records={() => host.recordsRef.current}
      />
    </Suspense>
  );
}

export const pcbSurface = hostKind(pcbKind, {
  Surface: PcbSurface,
  session: 'local',
  hooks: { comments: false },
});
