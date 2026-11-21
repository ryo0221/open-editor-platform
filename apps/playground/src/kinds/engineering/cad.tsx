import { lazy, Suspense } from 'react';
import type { CadDocument } from '@editor-platform/cad-core';
import type { EditorSession } from '@editor-platform/editor-core';
import { editedDraft } from '../../app/records';
import { createLocalSession } from '../../model';
import { cadDefinition } from '../engineering';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';
import { assertCadContentFits } from '../../cad/native-size';
import { portableCadRecord, validateCadRecord } from '../../cad/resources';

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

export const cadSurface = hostKind(cadDefinition, {
  Surface: CadSurface,
  session: 'local',
  hooks: {
    // CAD Undo/Redo is admitted like an edit: the native file must still import (CAD23).
    // The history entry itself is checked, so content counted before is not encoded again.
    history({ session, direction, record }) {
      try {
        const candidate = session.peekHistory(direction);
        if (candidate !== undefined)
          assertCadContentFits(
            record,
            candidate as unknown as CadDocument,
            direction === 'undo' ? 'Undoする' : 'Redoする',
          );
        return { content: session[direction]() as unknown as CadDocument };
      } catch (e) {
        return { refused: (e as Error).message };
      }
    },
    restore(record, content) {
      assertCadContentFits(record, content, 'この版に戻す');
      return content;
    },
    // A version may only name CAD assets the record keeps.
    beforeVersion: (record) => validateCadRecord(portableCadRecord(record)),
    comments: false,
  },
});
