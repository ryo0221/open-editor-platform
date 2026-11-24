import { lazy, Suspense } from 'react';
import type { SimulationDocument } from '@editor-platform/simulation-core';
import { simulationKind } from '@editor-platform/simulation/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { useEditorDraftPort } from '../editor-draft-port';
import { latestRecord } from '../surface-host';

const SimulationHost = lazy(() => import('../../simulation/host'));

function SimulationSurface({ host }: HostSurfaceProps<SimulationDocument>) {
  const draft = useEditorDraftPort<SimulationDocument>(host);
  const shared = !!host.sharedSession;
  return (
    <Suspense fallback={<p className="empty-state">Loading Structural analysis…</p>}>
      <SimulationHost
        session={draft}
        shared={shared}
        readOnly={host.readOnly}
        inputs={host.inputs}
        record={() => (shared ? host.active : latestRecord(host))}
        records={() => host.recordsRef.current}
        persist={(content) => {
          if (shared) return;
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
        persistRecord={async (record) => (await host.persist(record)) !== false}
      />
    </Suspense>
  );
}

export const simulationSurface = hostKind(simulationKind, {
  Surface: SimulationSurface,
  hooks: {
    commentsButton: 'disabled',
    comments: false,
  },
});
