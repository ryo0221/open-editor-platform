import { lazy, Suspense } from 'react';
import type { ConstructionDocument } from '@editor-platform/construction-core';
import type { EditorSession } from '@editor-platform/editor-core';
import { constructionKind } from '@editor-platform/construction/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const ConstructionHost = lazy(() => import('../../construction/host'));

function ConstructionSurface({ host }: HostSurfaceProps<ConstructionDocument>) {
  return (
    <Suspense fallback={<p className="empty-state">Loading Construction schedule…</p>}>
      <ConstructionHost
        session={
          host.sessions.current.get(
            host.active.id,
          ) as unknown as EditorSession<ConstructionDocument>
        }
        readOnly={host.readOnly}
        inputs={host.inputs}
        record={() => latestRecord(host)}
        records={() => host.recordsRef.current}
        persist={(content) => {
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
        persistRecord={async (record) => (await host.persist(record)) !== false}
      />
    </Suspense>
  );
}

export const constructionSurface = hostKind(constructionKind, {
  Surface: ConstructionSurface,
  session: 'local',
});
