import { lazy, Suspense } from 'react';
import type { BimDocument } from '@editor-platform/bim-core';
import type { EditorSession } from '@editor-platform/editor-core';
import { bimKind } from '@editor-platform/bim/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

// The building Surface and its kernel Worker load only when a building opens.
const BimHost = lazy(() => import('../../bim/host'));

function BimSurface({ host }: HostSurfaceProps<BimDocument>) {
  return (
    <Suspense fallback={<p className="empty-state">Loading Building…</p>}>
      <BimHost
        artifact={host.active}
        session={host.sessions.current.get(host.active.id) as unknown as EditorSession<BimDocument>}
        readOnly={host.readOnly}
        inputs={host.inputs}
        persist={(content) => {
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
        record={() => latestRecord(host)}
        persistRecord={async (record) => (await host.persist(record)) !== false}
        records={() => host.recordsRef.current}
      />
    </Suspense>
  );
}

export const bimSurface = hostKind(bimKind, { Surface: BimSurface, session: 'local' });
