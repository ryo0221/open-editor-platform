import { TimelineSaveRecovery } from './save-recovery';
import { browserTimelineRecoveryStore } from './recovery-store';
import { createRoot } from 'react-dom/client';
import {
  IndexedDBStorage,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import { readWorkspaceLinks, type CreativeWorkspaceLinksV2 } from '../workspace/model';
import { showCreativeError } from '../browser';
import { SHARED_UNSUPPORTED, StoryTimelineHost } from './host';
import { createF0Sample } from './sample';
import { TimelineWorkbench } from './workbench';

export const STORY_TIMELINE_LINKS_KEY = 'story-timeline:links';

/** Browser storage of the reading page: Artifacts in IndexedDB and the Story links. */
export function createBrowserTimelineStorage(
  artifacts: StorageAdapter<Artifact<unknown>> = new IndexedDBStorage<Artifact<unknown>>(),
  key = STORY_TIMELINE_LINKS_KEY,
) {
  return {
    artifacts,
    readLinks(): CreativeWorkspaceLinksV2 | undefined {
      const s = localStorage.getItem(key);
      if (!s) return undefined;
      const links = readWorkspaceLinks(JSON.parse(s));
      if (links.schemaVersion !== 2)
        throw Error('Storyの結び付けがありません（参照表が版1です）。');
      return links;
    },
    async writeLinks(links: CreativeWorkspaceLinksV2) {
      localStorage.setItem(key, JSON.stringify(links));
    },
  };
}

/**
 * Mounts the Story Timeline. It reads until the author starts editing; then the Story's
 * owners open in a workbench and each edit goes to its own owner's draft, saved only by that
 * owner's save button. Before that, only the start screen's sample button writes. The
 * returned `permissionsChanged` is called by the host when read permissions may have changed:
 * the reading and any open trip are hidden at once and read again.
 */
export async function mountStoryTimeline(options?: {
  mayRead?(artifactId: string): boolean;
  /** Whether an owner may be changed. Checked again at every edit, Undo and save. */
  mayEdit?(artifactId: string): boolean;
  /** Refused: T1 has no shared reading and never falls back to a local one (TL29b). */
  shared?: boolean;
}): Promise<{ permissionsChanged(): void }> {
  if (options?.shared) throw Error(SHARED_UNSUPPORTED);
  const io = createBrowserTimelineStorage();
  const mayRead = options?.mayRead ?? (() => true);
  const mayEdit = options?.mayEdit ?? (() => true);
  const root = createRoot(document.getElementById('root')!);
  const source = { get: (id: string) => io.artifacts.get(id) };
  let epoch = 0;
  let shown: CreativeWorkspaceLinksV2 | undefined;
  let workbench: TimelineWorkbench | undefined;
  let recovery: TimelineSaveRecovery | undefined;
  const render = (links: CreativeWorkspaceLinksV2) => {
    shown = links;
    root.render(
      <StoryTimelineHost
        source={source}
        links={links}
        mayRead={mayRead}
        permissionEpoch={epoch}
        workbench={workbench}
        recovery={recovery}
        startEditing={async () => {
          workbench = await TimelineWorkbench.open(io.artifacts, links, { mayRead, mayEdit });
          recovery = new TimelineSaveRecovery(
            workbench,
            browserTimelineRecoveryStore(STORY_TIMELINE_LINKS_KEY, io.artifacts),
            (next) => {
              Object.assign(workbench!.links, structuredClone(next));
              workbench!.invalidate();
              render(next);
            },
          );
          render(links);
        }}
      />,
    );
  };
  const handle = {
    permissionsChanged() {
      epoch++;
      if (shown) render(shown);
    },
  };
  const links = io.readLinks();
  if (links) {
    render(links);
    return handle;
  }
  root.render(
    <main className="story-timeline tl-start">
      <header>
        <h1>物語タイムライン</h1>
        <p>
          二つの世界、裏の出来事、回想と再提示を含む見本の作品を作り、世界時間・構成の提示順・世界線で読みます。
        </p>
        <button
          type="button"
          onClick={async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              render(await createF0Sample(io));
            } catch (e) {
              if (button.isConnected) button.disabled = false;
              showCreativeError(e);
            }
          }}
        >
          見本の作品を作成
        </button>
      </header>
    </main>,
  );
  return handle;
}
