import { lazy, Suspense } from 'react';
import type { CosimDocument } from '@editor-platform/cosim-core';
import { useEditorDraftPort } from '../editor-draft-port';
import { cosimKind } from '@editor-platform/cosim/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const CosimHost = lazy(() => import('../../cosim/host'));

function CosimSurface({ host }: HostSurfaceProps<CosimDocument>) {
  const session = useEditorDraftPort<CosimDocument>(host);
  return (
    <Suspense fallback={<p className="empty-state">Loading Co-simulation…</p>}>
      <CosimHost
        artifact={host.active}
        records={() => host.recordsRef.current}
        session={session}
        shared={host.shared}
        readOnly={host.readOnly}
        inputs={host.inputs}
        persist={(content) => {
          if (host.shared) return;
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
      />
    </Suspense>
  );
}

export const cosimSurface = hostKind(cosimKind, {
  Surface: CosimSurface,
  hooks: {
    commentsButton: 'disabled',
    pendingInputs: {
      refusal: 'Co-simulation の入力を確定またはキャンセルしてから履歴を操作してください。',
    },
    comments: false,
  },
});
