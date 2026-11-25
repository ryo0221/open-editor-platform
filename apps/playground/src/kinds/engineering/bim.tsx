import { lazy, Suspense } from 'react';
import type { BimDocument } from '@editor-platform/bim-core';
import { bimKind } from '@editor-platform/bim/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { useEditorDraftPort } from '../editor-draft-port';
import { latestRecord } from '../surface-host';
import { portableBimRecord, validateBimParts } from '../../bim/parts';
import { portableCadRecord, validateCadRecord } from '../../cad/resources';

// The building Surface and its kernel Worker load only when a building opens.
const BimHost = lazy(() => import('../../bim/host'));

function BimSurface({ host }: HostSurfaceProps<BimDocument>) {
  const draft = useEditorDraftPort<BimDocument>(host);
  const shared = !!host.sharedSession;
  return (
    <Suspense fallback={<p className="empty-state">Loading Building…</p>}>
      <BimHost
        artifact={host.active}
        session={draft}
        shared={shared}
        readOnly={host.readOnly}
        inputs={host.inputs}
        persist={(content) => {
          if (shared) return;
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
        record={() => (shared ? host.active : latestRecord(host))}
        persistRecord={async (record) => (await host.persist(record)) !== false}
        records={() => host.recordsRef.current}
      />
    </Suspense>
  );
}

export const bimSurface = hostKind(bimKind, {
  Surface: BimSurface,
  hooks: {
    commentsButton: 'disabled',
    // A building's version may only place CAD versions the record keeps.
    async beforeVersion(record) {
      validateBimParts(portableBimRecord(record));
      await validateCadRecord(portableCadRecord(record));
    },
    comments: false,
  },
});
