import { lazy, Suspense } from 'react';
import type { SimulationDocument } from '@editor-platform/simulation-core';
import type { EditorSession } from '@editor-platform/editor-core';
import { simulationKind } from '@editor-platform/simulation/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const SimulationHost = lazy(() => import('../../simulation/host'));

function SimulationSurface({ host }: HostSurfaceProps<SimulationDocument>) {
  return (
    <Suspense fallback={<p className="empty-state">Loading Structural analysis…</p>}>
      <SimulationHost
        session={
          host.sessions.current.get(host.active.id) as unknown as EditorSession<SimulationDocument>
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

export const simulationSurface = hostKind(simulationKind, {
  Surface: SimulationSurface,
  session: 'local',
});
