import { lazy, Suspense } from 'react';
import type { PcbDocument } from '@editor-platform/pcb-core';
import { useEditorDraftPort } from '../editor-draft-port';
import { pcbKind } from '@editor-platform/pcb/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const PcbHost = lazy(() => import('../../pcb/host'));

function PcbSurface({ host }: HostSurfaceProps<PcbDocument>) {
  const session = useEditorDraftPort<PcbDocument>(host);
  return (
    <Suspense fallback={<p className="empty-state">Loading Circuit board…</p>}>
      <PcbHost
        artifact={host.active}
        session={session}
        shared={host.shared}
        readOnly={host.readOnly}
        inputs={host.inputs}
        persist={(content) => {
          if (host.shared) return;
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
  hooks: {
    commentsButton: 'disabled',
    comments: false,
  },
});
