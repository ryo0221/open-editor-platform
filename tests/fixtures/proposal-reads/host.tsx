/** Independent public-API Host for Issue #402: a plan Document proposal generated from a
 * Calendar (Schedule) and a Data Artifact is rechecked against their exact versions at
 * preview and apply. Single-user reference fixture; the Host here is not an authority. */
import { useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  commitVersion,
  createArtifact,
  deserializeArtifact,
  newId,
  serializeArtifact,
  updateDraft,
  type Artifact,
  type CurrentRead,
  type StaleRead,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import { EditorState } from 'prosemirror-state';
import type { EditorCommand, ProposedCommands } from '@editor-platform/editor-core';
import {
  captureDocumentUpdate,
  contentToNode,
  documentUpdateCommand,
  stableIds,
} from '@editor-platform/document/engine';
import {
  ArtifactEditor,
  applyHostProposal,
  loadHostArtifact,
  previewHostProposal,
  type EditorHostAdapter,
} from '@editor-platform/editor-host';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import { createSchedule, type ScheduleDocument } from '@editor-platform/schedule/model';
import { createData, type StructuredData } from '@editor-platform/structured-data/model';

const prefix = 'proposal-reads:';
const adapter: EditorHostAdapter<DocumentContent> = {
  kind: 'document',
  validate: isDocument,
  capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
};
const storage: Pick<StorageAdapter<Artifact<DocumentContent>>, 'put'> = {
  async put(value) {
    localStorage.setItem(prefix + 'plan', serializeArtifact(value));
  },
};
function plan(): DocumentContent {
  return {
    schemaVersion: 2,
    blocks: [
      { id: 'title', type: 'heading', text: '新製品の企画書' },
      { id: 'launch', type: 'paragraph', text: '発売日：未定' },
      { id: 'build', type: 'paragraph', text: '制作期間：未定' },
      { id: 'note', type: 'paragraph', text: '備考：販路は別紙' },
    ],
  };
}
function calendar(date: string, next: string): ScheduleDocument {
  return {
    ...createSchedule('Asia/Tokyo'),
    events: [
      {
        id: 'launch',
        title: '発売',
        notes: '',
        time: { kind: 'allDay', startDate: date, endDateExclusive: next },
        conference: 'none',
        links: [],
      },
    ],
  };
}
function data(weeks: number): StructuredData {
  const d = createData();
  d.columns = [
    { id: 'task', name: '作業', type: 'text' },
    { id: 'weeks', name: '週', type: 'number' },
  ];
  d.rows = [{ id: 'build', values: { task: '制作', weeks } }];
  return d;
}
async function saved<T>(id: string, kind: string, name: string, content: T) {
  const stored = localStorage.getItem(prefix + id);
  if (stored) return deserializeArtifact(stored) as Artifact<T>;
  const a = await commitVersion({ ...createArtifact(kind, name, content), id }, 'fixture', '初版');
  localStorage.setItem(prefix + id, serializeArtifact(a));
  return a;
}
async function open() {
  const stored = localStorage.getItem(prefix + 'plan');
  const doc = stored
    ? await loadHostArtifact(stored, adapter)
    : await saved('plan', 'document', '企画書', plan());
  return {
    doc,
    calendar: await saved('calendar', 'schedule', 'Calendar', calendar('2026-12-01', '2026-12-02')),
    data: await saved('data', 'data', 'Data', data(11)),
  };
}
const versionOf = (a: Artifact<unknown> | undefined) => a?.draft.baseVersionId ?? null;
const reasonText: Record<StaleRead['reason'], string> = {
  'version-changed': '版が変わった',
  'draft-changed': '下書きが変わった',
  missing: '削除された',
  forbidden: '閲覧権限が無い',
  unverified: '確認できない',
};

function Host({ initial }: { initial: Awaited<ReturnType<typeof open>> }) {
  const [, render] = useReducer((n: number) => n + 1, 0);
  const editor = useRef(new ArtifactEditor(initial.doc, adapter, storage)).current;
  // The Host's own view of the referenced Artifacts and of the reviewer's access to them.
  const refs = useRef<Record<'calendar' | 'data', Artifact<unknown> | undefined>>({
    calendar: initial.calendar,
    data: initial.data,
  }).current;
  const denied = useRef(new Set<string>()).current;
  const [proposal, setProposal] = useState<ProposedCommands<DocumentContent>>();
  const [preview, setPreview] = useState<DocumentContent>();
  const [stale, setStale] = useState<StaleRead[]>([]);
  const [status, setStatus] = useState('提案なし');
  const read = (id: string): CurrentRead | undefined => {
    if (id !== 'calendar' && id !== 'data') return undefined;
    if (denied.has(id)) return { status: 'forbidden' };
    const a = refs[id];
    return a ? { status: 'available', versionId: versionOf(a) } : { status: 'missing' };
  };
  async function commit(id: 'calendar' | 'data', content: unknown) {
    const next = await commitVersion(updateDraft(refs[id]!, content), 'other person', '更新');
    refs[id] = next;
    localStorage.setItem(prefix + id, serializeArtifact(next));
    render();
  }
  /** Deterministic stand-in for an external generator: reads both references now. */
  function generate() {
    const cal = refs.calendar?.draft.content as ScheduleDocument,
      rows = refs.data?.draft.content as StructuredData;
    const time = cal.events[0].time;
    const date = time.kind === 'allDay' ? time.startDate : time.startLocal;
    // Prepare the text through the native Document engine: one transaction, two blocks.
    const textEdit = (edits: [string, string][]): EditorCommand<DocumentContent> => {
      const base = editor.content;
      const state = EditorState.create({ doc: contentToNode(base), plugins: [stableIds] });
      const tr = state.tr;
      for (const [id, text] of edits)
        tr.doc.forEach((node, offset) => {
          if (node.attrs.id === id) tr.insertText(text, offset + 1, offset + 1 + node.content.size);
        });
      const update = captureDocumentUpdate(state.applyTransaction(tr).transactions);
      return documentUpdateCommand(base, update, {
        origin: 'proposal',
        transactionId: newId('transaction'),
      });
    };
    const next: ProposedCommands<DocumentContent> = {
      id: crypto.randomUUID(),
      summary: '発売日と制作期間を参照元に合わせる',
      source: '試験用の決定的な生成',
      baseLocalRevision: editor.revision,
      reads: {
        target: { artifactId: editor.id, versionId: versionOf(editor.artifact) },
        references: (['calendar', 'data'] as const).map((id) => ({
          artifactId: id,
          versionId: versionOf(refs[id])!,
        })),
      },
      commands: [
        textEdit([
          ['launch', `発売日：${date}`],
          ['build', `制作期間：${rows.rows[0].values.weeks}週`],
        ]),
      ],
    };
    setProposal(next);
    setPreview(undefined);
    setStale([]);
    setStatus('提案あり');
  }
  function review() {
    const r = previewHostProposal(editor, proposal!, read);
    setPreview(r.preview?.content);
    setStale(r.check.stale);
    setStatus(r.check.fresh ? 'プレビュー中' : '古い提案');
  }
  function apply() {
    const check = applyHostProposal(editor, proposal!, read);
    setStale(check.stale);
    if (!check.fresh) {
      // Keep the stale proposal for the person to discard or regenerate, not its result.
      setPreview(undefined);
      setStatus('古い提案');
      return;
    }
    setProposal(undefined);
    setPreview(undefined);
    setStatus('採用した');
  }
  const doc = editor.content;
  return (
    <main style={{ fontFamily: 'sans-serif', padding: 16, maxWidth: 720 }}>
      <h1>提案の鮮度確認</h1>
      <p>試験用の独立 Host。参照元の版を、プレビューと採用の時点で確かめる。</p>
      <section aria-label="企画書">
        <h2>企画書</h2>
        <ul aria-label="企画書の内容">
          {doc.blocks.map((b) => (
            <li key={b.id}>{b.text}</li>
          ))}
        </ul>
        <p>
          版の数：<output aria-label="企画書の版">{editor.artifact.versions.length}</output>
        </p>
        <button onClick={() => void editor.save({ commitVersion: true }).then(render)}>保存</button>
      </section>
      <section aria-label="参照元">
        <h2>参照元</h2>
        <p>
          Calendar の版の数：
          <output aria-label="Calendarの版">{refs.calendar?.versions.length ?? '削除'}</output>
          ・Data の版の数：
          <output aria-label="Dataの版">{refs.data?.versions.length ?? '削除'}</output>
        </p>
        <button onClick={() => void commit('calendar', calendar('2027-01-15', '2027-01-16'))}>
          Calendarを更新
        </button>
        <button onClick={() => void commit('data', data(14))}>Dataを更新</button>
        <button
          onClick={() => {
            refs.data = undefined;
            render();
          }}
        >
          Dataを削除
        </button>
        <button
          onClick={() => {
            denied.add('calendar');
            render();
          }}
        >
          Calendarの権限を外す
        </button>
      </section>
      <section aria-label="提案">
        <h2>提案</h2>
        <p>
          状態：<output aria-label="提案の状態">{status}</output>
        </p>
        <ul aria-label="古い理由">
          {stale.map((s) => (
            <li key={s.artifactId}>
              {s.artifactId}：{reasonText[s.reason]}
            </li>
          ))}
        </ul>
        {preview && (
          <ul aria-label="提案の結果">
            {preview.blocks.map((b) => (
              <li key={b.id}>{b.text}</li>
            ))}
          </ul>
        )}
        <button onClick={generate}>提案を作る</button>
        <button disabled={!proposal} onClick={review}>
          プレビュー
        </button>
        <button disabled={!proposal} onClick={apply}>
          採用
        </button>
        <button
          disabled={!proposal}
          onClick={() => {
            setProposal(undefined);
            setPreview(undefined);
            setStale([]);
            setStatus('破棄した');
          }}
        >
          破棄
        </button>
      </section>
    </main>
  );
}
void open().then((initial) =>
  createRoot(document.getElementById('root')!).render(<Host initial={initial} />),
);
