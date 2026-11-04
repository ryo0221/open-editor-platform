import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalJson, type Artifact, type StorageAdapter } from '@editor-platform/artifact-core';
import { createBrowserTimelineStorage } from '../timeline/browser';
import { StoryBoardController, type StoryBoardAccess } from './controller';
import { createStoryBoardSample } from './sample';
import { StoryBoardHost } from './host';

const SETTINGS_KEY = 'story-board:settings-id';
const LINKS_KEY = 'story-board:links';
export interface StoryBoardMountOptions {
  artifacts?: StorageAdapter<Artifact<unknown>>;
  settingsId?: string;
  namespace?: string;
  linksKey?: string;
  mayRead?(id: string): boolean;
  mayEdit?(id: string): boolean;
}

/** Local normal/independent Host entry. No scan or implicit binding from node text. */
export function mountStoryBoard(options: StoryBoardMountOptions = {}) {
  const io = createBrowserTimelineStorage(options.artifacts, options.linksKey ?? LINKS_KEY);
  const root = createRoot(document.getElementById('root')!);
  const access: StoryBoardAccess = {
    namespace: options.namespace ?? 'reference-story-board',
    mayRead: options.mayRead ?? (() => true),
    mayEdit: options.mayEdit ?? (() => true),
  };
  let active: StoryBoardController | undefined,
    notification = 0;
  function Page({ epoch }: { epoch: number }) {
    const [controller, setController] = useState<StoryBoardController>();
    const [id, setId] = useState(() => {
      try {
        const saved = options.settingsId ?? localStorage.getItem(SETTINGS_KEY) ?? '';
        return saved && access.mayRead(saved) ? saved : '';
      } catch {
        return '';
      }
    });
    const [editingId, setEditingId] = useState(false);
    const [busy, setBusy] = useState(false),
      [message, setMessage] = useState('');
    const request = useRef(0),
      first = useRef(true);
    useEffect(() => {
      request.current++;
      setBusy(false);
    }, [epoch]);
    async function open(settingsId: string) {
      const ticket = ++request.current;
      const generation = notification;
      const current = () => ticket === request.current && generation === notification;
      setBusy(true);
      setMessage('');
      try {
        if (!settingsId.trim() || !access.mayRead(settingsId)) throw Error();
        setEditingId(false);
        const links = io.readLinks();
        if (!links) throw Error();
        const next = await StoryBoardController.open(io.artifacts, settingsId, links, access);
        if (!current()) {
          next.close();
          return;
        }
        active = next;
        setController(next);
        try {
          localStorage.setItem(SETTINGS_KEY, settingsId);
        } catch {
          /* private reopen preference only */
        }
      } catch {
        if (current())
          setMessage(
            '指定した表示設定とStoryを開けません。設定ID・保存先・権限を確認してください。',
          );
      } finally {
        if (current()) setBusy(false);
      }
    }
    useEffect(() => {
      if (first.current) {
        first.current = false;
        if (id) void open(id);
      }
    }, []);
    if (controller)
      return (
        <StoryBoardHost
          key={controller.viewKey}
          controller={controller}
          changeBoard={() => {
            active = undefined;
            setController(undefined);
          }}
        />
      );
    // Redact retained preferences, while keeping the author's incomplete input buffer editable.
    const visibleId = editingId || (id && access.mayRead(id)) ? id : '';
    return (
      <main className="story-board sb-start">
        <span className="sb-eyebrow">STORY WORKSPACE</span>
        <h1>人物・地図・出来事を、一枚のボードへ。</h1>
        <p>
          既存のWhiteboardに、人物の時系列と地図、参照付きの出来事を並べます。同じ時点と表示条件で、複数地点の同時進行を追えます。
        </p>
        <label>
          表示設定のArtifact ID
          <input
            aria-label="表示設定のArtifact ID"
            value={visibleId}
            onChange={(event) => {
              setId(event.target.value);
              setEditingId(true);
            }}
            disabled={busy}
          />
        </label>
        <button disabled={busy || !visibleId.trim()} onClick={() => void open(visibleId)}>
          指定したボードを開く
        </button>
        <hr />
        <h2>合成の見本で試す</h2>
        <p>
          10人・3地点・同時進行を含む「霧の王国」を別のArtifactとして作ります。既存の資料は上書きしません。
        </p>
        <button
          disabled={busy}
          onClick={async () => {
            const ticket = ++request.current;
            const generation = notification;
            const currentRequest = () => ticket === request.current && generation === notification;
            setBusy(true);
            setMessage('');
            try {
              const previous = io.readLinks();
              if (previous && previous.story.id !== 'sb660-story-S') throw Error();
              const sample = await createStoryBoardSample(
                io.artifacts,
                (id) => currentRequest() && access.mayRead(id) && access.mayEdit(id),
              );
              if (!currentRequest()) return;
              const current = io.readLinks();
              if (
                canonicalJson(current ?? null) !== canonicalJson(previous ?? null) ||
                (current && canonicalJson(current) !== canonicalJson(sample.links))
              )
                throw Error();
              if (!current) await io.writeLinks(sample.links);
              if (!currentRequest()) return;
              setId(sample.settingsId);
              await open(sample.settingsId);
            } catch {
              if (currentRequest()) {
                setMessage(
                  '見本の作成を完了できません。保存先と既存資料を確認して再試行してください。',
                );
                setBusy(false);
              }
            }
          }}
        >
          10人の物語ボードを作る
        </button>
        <p role="status">{busy ? '資料を確認しています…' : message}</p>
      </main>
    );
  }
  const render = () => root.render(<Page epoch={notification} />);
  render();
  return {
    permissionsChanged() {
      notification++;
      active?.invalidate();
      render();
    },
    sourcesChanged() {
      notification++;
      active?.invalidate();
      render();
    },
  };
}
