import { lazy, Suspense } from 'react';
import type { CharacterDocument } from '@editor-platform/character-core';
import type { EditorSession } from '@editor-platform/editor-core';
import { characterKind } from '@editor-platform/character/kind';
import { editedDraft } from '../../app/records';
import { hostKind, type HostSurfaceProps } from '../host-kind';
import { latestRecord } from '../surface-host';
import { portableCadRecord, validateCadRecord } from '../../cad/resources';
import { assertCharacterHistoryFits } from '../../character/import-fit';

const CharacterHost = lazy(() => import('../../character/host'));

function CharacterSurface({ host }: HostSurfaceProps<CharacterDocument>) {
  return (
    <Suspense fallback={<p className="empty-state">Loading Character…</p>}>
      <CharacterHost
        session={
          host.sessions.current.get(host.active.id) as unknown as EditorSession<CharacterDocument>
        }
        readOnly={host.readOnly}
        persist={(content) => {
          const latest = latestRecord(host);
          if (latest) host.persist(editedDraft(latest, content));
        }}
        record={() => latestRecord(host)}
        persistRecord={async (record) => (await host.persist(record)) !== false}
        records={() => host.recordsRef.current}
        history={host.history}
      />
    </Suspense>
  );
}

export const characterSurface = hostKind(characterKind, {
  Surface: CharacterSurface,
  session: 'local',
  hooks: {
    history({ session, direction, record }) {
      try {
        const candidate = session.peekHistory(direction);
        if (candidate !== undefined)
          assertCharacterHistoryFits(record, candidate as unknown as CharacterDocument);
        return { content: session[direction]() as unknown as CharacterDocument };
      } catch (e) {
        return {
          refused: `${direction === 'undo' ? 'Undo' : 'Redo'} not applied: ${(e as Error).message}`,
        };
      }
    },
    restore(record, content) {
      assertCharacterHistoryFits(record, content);
      return content;
    },
    // A character's version may only name assets the record keeps.
    beforeVersion: (record) => validateCadRecord(portableCadRecord(record)),
    comments: false,
  },
});
