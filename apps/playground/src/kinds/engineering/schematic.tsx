import { lazy, Suspense } from 'react';
import type { SchematicDocument } from '@editor-platform/schematic-core';
import type { EditorSession } from '@editor-platform/editor-core';
import { schematicKind } from '@editor-platform/schematic/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';

const SchematicHost = lazy(() => import('../../schematic/host'));

function SchematicSurface({ host }: HostSurfaceProps<SchematicDocument>) {
  return (
    <Suspense fallback={<p className="empty-state">Loading Schematic…</p>}>
      <SchematicHost
        artifact={host.active}
        session={
          host.sessions.current.get(host.active.id) as unknown as EditorSession<SchematicDocument>
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

export const schematicSurface = hostKind(schematicKind, {
  Surface: SchematicSurface,
  session: 'local',
  hooks: {
    sharedSessions: false,
    commentsButton: 'disabled',
    // A draft its commit refused would be lost when Undo or Redo removes or changes its item.
    pendingInputs: {
      refusal: 'Schematic の入力を確定またはキャンセルしてから履歴を操作してください。',
    },
    comments: false,
  },
});
