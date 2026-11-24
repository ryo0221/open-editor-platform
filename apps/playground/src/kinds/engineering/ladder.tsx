import { lazy, Suspense } from 'react';
import type { LadderDocument } from '@editor-platform/ladder-core';
import { useEditorDraftPort } from '../editor-draft-port';
import { ladderKind } from '@editor-platform/ladder/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const LadderHost = lazy(() => import('../../ladder/host'));

function LadderSurface({ host }: HostSurfaceProps<LadderDocument>) {
  const session = useEditorDraftPort<LadderDocument>(host);
  return (
    <Suspense fallback={<p className="empty-state">Loading Ladder…</p>}>
      <LadderHost
        artifact={host.active}
        session={session}
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

export const ladderSurface = hostKind(ladderKind, {
  Surface: LadderSurface,
  hooks: {
    commentsButton: 'disabled',
    pendingInputs: {
      refusal: 'Ladder の入力を確定またはキャンセルしてから履歴を操作してください。',
    },
    comments: false,
  },
});
