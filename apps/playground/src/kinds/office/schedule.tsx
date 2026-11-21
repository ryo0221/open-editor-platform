import { useMemo } from 'react';
import { dataTimelineOptions, scheduleLaneHost } from '@editor-platform/reference-adapters';
import type { ScheduleDocument } from '@editor-platform/schedule/model';
import { ScheduleSurface } from '@editor-platform/schedule/view';
import { scheduleDefinition } from '../office';
import { hostKind } from '../host-kind';
import type { SurfaceHost } from '../surface-host';
import { stepScheduleHistory } from '@editor-platform/schedule/history';
import type { EditorSession } from '@editor-platform/editor-core';

function ScheduleHost({ host, content }: { host: SurfaceHost; content: ScheduleDocument }) {
  const { references, savedRecords } = host;
  // Lanes read saved Data versions only; drafts are never referenced.
  const lanes = useMemo(
    () =>
      scheduleLaneHost(references, async () =>
        dataTimelineOptions(
          [...savedRecords.current.values()]
            .filter((record) => record.kind === 'data' && record.versions.length)
            .map((record) => ({
              id: record.id,
              name: record.name,
              content: record.versions.at(-1)!.content,
            })),
        ),
      ),
    [references, savedRecords],
  );
  return (
    <ScheduleSurface
      content={content}
      execute={host.execute}
      readOnly={host.readOnly}
      select={host.select}
      selectedId={host.selection.addresses[0]?.elementId}
      focusAddress={host.revealAddress}
      lanes={host.shared ? undefined : lanes}
    />
  );
}

export const scheduleSurface = hostKind(scheduleDefinition, {
  Surface: ScheduleHost,
  hooks: {
    // Removing a Schedule event while details hold refused text could lose it: refused.
    history({ session, direction, pending }) {
      const local = session as unknown as EditorSession<ScheduleDocument>;
      const step = stepScheduleHistory(local, direction, local.content, pending);
      return 'refused' in step ? { refused: step.refused } : { content: step.content };
    },
    flushBeforeReadOnly: true,
  },
});
