import { lazy, Suspense } from 'react';
import type { LadderDocument } from '@editor-platform/ladder-core';
import type { EditorSession } from '@editor-platform/editor-core';
import { ladderKind } from '@editor-platform/ladder/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const LadderHost = lazy(() => import('../../ladder/host'));

function LadderSurface({ host }: HostSurfaceProps<LadderDocument>) {
  return (
    <Suspense fallback={<p className="empty-state">Loading Ladder…</p>}>
      <LadderHost
        artifact={host.active}
        session={
          host.sessions.current.get(host.active.id) as unknown as EditorSession<LadderDocument>
        }
        readOnly={host.readOnly}
        inputs={host.inputs}
        persist={(content) => {
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
      />
    </Suspense>
  );
}

export const ladderSurface = hostKind(ladderKind, { Surface: LadderSurface, session: 'local' });
