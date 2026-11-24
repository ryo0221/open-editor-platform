import { lazy, Suspense } from 'react';
import type { SchematicDocument } from '@editor-platform/schematic-core';
import { useEditorDraftPort } from '../editor-draft-port';
import { schematicKind } from '@editor-platform/schematic/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const SchematicHost = lazy(() => import('../../schematic/host'));

function SchematicSurface({ host }: HostSurfaceProps<SchematicDocument>) {
  const session = useEditorDraftPort<SchematicDocument>(host);
  return (
    <Suspense fallback={<p className="empty-state">Loading Schematic…</p>}>
      <SchematicHost
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

export const schematicSurface = hostKind(schematicKind, {
  Surface: SchematicSurface,
  hooks: {
    commentsButton: 'disabled',
    // A draft its commit refused would be lost when Undo or Redo removes or changes its item.
    pendingInputs: {
      refusal: 'Schematic の入力を確定またはキャンセルしてから履歴を操作してください。',
    },
    comments: false,
  },
});
