import { lazy, Suspense } from 'react';
import type { FactoryDocument } from '@editor-platform/factory-core';
import { useEditorDraftPort } from '../editor-draft-port';
import { factoryKind } from '@editor-platform/factory/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const FactoryHost = lazy(() => import('../../factory/host'));

function FactorySurface({ host }: HostSurfaceProps<FactoryDocument>) {
  const session = useEditorDraftPort<FactoryDocument>(host);
  return (
    <Suspense fallback={<p className="empty-state">Loading Factory…</p>}>
      <FactoryHost
        artifact={host.active}
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

export const factorySurface = hostKind(factoryKind, {
  Surface: FactorySurface,
  hooks: {
    commentsButton: 'disabled',
    pendingInputs: {
      refusal: 'Factory の入力を確定またはキャンセルしてから履歴を操作してください。',
    },
    comments: false,
  },
});
