import { useEffect, useState } from 'react';
import { EditorSession } from '@editor-platform/editor-core';
import { FictionMapSurface } from '@editor-platform/fiction-map/surface';
import { validateFictionMap, type FictionMapContent } from '@editor-platform/fiction-map/model';
import { initialCanvasView } from '@editor-platform/canvas-ui';
import { StoryTimelineHost } from '../timeline/host';
import type { StoryBoardController } from './controller';
import type { BoardReading } from './reading';

export type BoardTrip =
  | {
      kind: 'timeline';
      selection?: { kind: 'event' | 'scene' | 'occurrence' | 'world'; key: string; world?: string };
    }
  | { kind: 'map' };

function SavedMap({ content }: { content: FictionMapContent }) {
  const [base] = useState(() => {
    // A real read-only native Session revision for the Surface; source remains the fixed exact.
    const session = new EditorSession(content),
      admitted = validateFictionMap(session.content);
    if (!admitted.ok) throw Error('固定地図を表示できません。');
    return { content: admitted.value, revision: session.revision };
  });
  const [view, setView] = useState({ ...initialCanvasView, fit: true });
  return (
    <FictionMapSurface
      base={base}
      readOnly
      onCommit={() => {
        throw Error('固定版は編集できません。');
      }}
      view={view}
      onViewChange={setView}
    />
  );
}

export function BoardSourceTrip({
  controller: c,
  trip,
  back,
  notice,
}: {
  controller: StoryBoardController;
  trip: BoardTrip;
  back(): void;
  notice: string;
}) {
  const epoch = c.epoch;
  const [loaded, setLoaded] = useState<{
    epoch: number;
    current(): boolean;
    map?: BoardReading;
  }>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (trip.kind === 'timeline') return;
    let live = true;
    const current = () => live && c.epoch === epoch;
    void (async () => {
      const value = await c.read();
      if (value.state !== 'ready' || !value.current() || !current()) throw Error();
      return { epoch, current: () => current() && value.current(), map: value };
    })()
      .then((value) => {
        if (current()) {
          setLoaded(value);
          setError('');
        }
      })
      .catch(() => {
        if (live) setError('この保存版を現在表示できません。');
      });
    return () => {
      live = false;
    };
  }, [c, epoch, trip]);
  const protectedOwners = [c.boardArtifactId, c.settingsId];
  const readable = protectedOwners.every((id) => c.access.mayRead(id));
  const saved = loaded?.epoch === epoch && loaded.current() ? loaded : undefined;
  return (
    <main className="story-board sb-source-frame">
      <header>
        <button onClick={back}>ボードへ戻る</button>
        <h1>{trip.kind === 'timeline' ? '物語の元資料' : '固定版の地図'}</h1>
        <p>
          {trip.kind === 'timeline'
            ? '元資料の現在draftを編集します。保存とUndoは各資料が所有します。ボードは採用保存版を読みます。'
            : '参照している保存版を読み取り専用で表示します。'}
        </p>
        <p role="status">{notice}</p>
      </header>
      <div className="sb-source-content">
        {!readable ? (
          <p role="status">この資料を現在表示できません。</p>
        ) : trip.kind === 'timeline' ? (
          <StoryTimelineHost
            source={c.workbench.source}
            links={c.workbench.links}
            mayRead={c.access.mayRead}
            permissionEpoch={c.permissionEpoch}
            workbench={c.workbench}
            initialSelection={trip.selection}
          />
        ) : error ? (
          <p role="alert">{error}</p>
        ) : !saved ? (
          <p role="status">保存版を読み込んでいます…</p>
        ) : saved.map ? (
          <div className="sb-fixed-map">
            <p>固定版：{saved.map.opened.settings.map.versionId}</p>
            <SavedMap key={saved.map.opened.settings.map.versionId} content={saved.map.map} />
          </div>
        ) : null}
      </div>
    </main>
  );
}
