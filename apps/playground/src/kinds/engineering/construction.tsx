import { lazy, Suspense } from 'react';
import type { ConstructionDocument } from '@editor-platform/construction-core';
import { useEditorDraftPort } from '../editor-draft-port';
import { constructionKind } from '@editor-platform/construction/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const ConstructionHost = lazy(() => import('../../construction/host'));

function ConstructionSurface({ host }: HostSurfaceProps<ConstructionDocument>) {
  const session = useEditorDraftPort<ConstructionDocument>(host);
  return (
    <Suspense fallback={<p className="empty-state">Loading Construction schedule…</p>}>
      <ConstructionHost
        session={session}
        shared={host.shared}
        readOnly={host.readOnly}
        inputs={host.inputs}
        record={() => latestRecord(host)}
        records={() => host.recordsRef.current}
        persist={(content) => {
          if (host.shared) return;
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
        persistRecord={async (record) => !host.shared && (await host.persist(record)) !== false}
      />
    </Suspense>
  );
}

export const constructionSurface = hostKind(constructionKind, {
  Surface: ConstructionSurface,
  hooks: {
    commentsButton: 'disabled',
    comments: false,
  },
});
