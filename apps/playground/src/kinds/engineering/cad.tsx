import { lazy, Suspense } from 'react';
import type { CadDocument } from '@editor-platform/cad-core';
import type { EditorSession } from '@editor-platform/editor-core';
import { editedDraft } from '../../app/records';
import { createLocalSession } from '../../model';
import { cadDefinition } from '../engineering';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

// Three.js and the kernel adapter load only when a CAD artifact opens.
const CadHost = lazy(() => import('../../cad/host'));

function CadSurface({ host }: HostSurfaceProps<CadDocument>) {
  return (
    <Suspense fallback={<p className="empty-state">Loading 3D CAD…</p>}>
      <CadHost
        artifact={host.active}
        session={host.sessions.current.get(host.active.id) as unknown as EditorSession<CadDocument>}
        readOnly={host.readOnly}
        inputs={host.inputs}
        persist={(content) => {
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
        record={() => latestRecord(host)}
        persistRecord={async (record) => (await host.persist(record)) !== false}
        createRecord={async (record) => {
          // CR3e: a part made from a body is a new Artifact beside this one, not opened.
          host.sessions.current.set(record.id, createLocalSession(record.draft.content));
          return (await host.persist(record)) !== false;
        }}
        records={() => host.recordsRef.current}
        openArtifact={(id) => host.activate(id)}
      />
    </Suspense>
  );
}

export const cadSurface = hostKind(cadDefinition, { Surface: CadSurface, session: 'local' });
