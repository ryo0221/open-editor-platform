import { lazy, Suspense } from 'react';
import type { CosimDocument } from '@editor-platform/cosim-core';
import type { EditorSession } from '@editor-platform/editor-core';
import { cosimKind } from '@editor-platform/cosim/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const CosimHost = lazy(() => import('../../cosim/host'));

function CosimSurface({ host }: HostSurfaceProps<CosimDocument>) {
  return (
    <Suspense fallback={<p className="empty-state">Loading Co-simulation…</p>}>
      <CosimHost
        artifact={host.active}
        records={() => host.recordsRef.current}
        session={
          host.sessions.current.get(host.active.id) as unknown as EditorSession<CosimDocument>
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

export const cosimSurface = hostKind(cosimKind, {
  Surface: CosimSurface,
  session: 'local',
  hooks: {
    sharedSessions: false,
    commentsButton: 'disabled',
    pendingInputs: {
      refusal: 'Co-simulation の入力を確定またはキャンセルしてから履歴を操作してください。',
    },
    comments: false,
  },
});
