import { useEffect, useState, type FormEvent } from 'react';
import {
  HttpEditorAdapter,
  SharedEditorSession,
  splitVideoTimeline,
  videoTimelineAction,
  videoTimelineCodec,
  type EditorConnectionCredentials,
  type SharedVideoEdit,
} from '@editor-platform/collaboration-adapters';
import {
  add,
  subtract,
  time,
  type ClipV3,
  type Time,
  type VideoContentV3,
} from '@editor-platform/video-core';
import type { Snapshot } from '@editor-platform/collaboration-core';
import './workspace.css';

type Actor = 'A' | 'B' | 'C';
type Session = SharedEditorSession<VideoContentV3>;
type Mode = 'move' | 'trim' | 'split' | 'caption-text';
type Input = { base: Snapshot<VideoContentV3>; start: string; end: string; text: string };
const actorIDs = ['A', 'B', 'C'] as const;
const messages: Record<Mode, string> = {
  move: '移動',
  trim: 'トリミング',
  split: '分割',
  'caption-text': '字幕を変更',
};
const names: Record<string, string> = {
  'picture-track': '映像',
  'sound-track': '音声',
  'caption-track': '字幕',
  'locked-track': '固定の字幕',
};
const displayTime = ({ value, timescale }: Time) =>
  timescale === 1 ? String(value) : `${value}/${timescale}`;
const seconds = ({ value, timescale }: Time) => value / timescale;
const parse = (value: string) => {
  const match = /^(-?\d+)(?:\/(\d+))?$/.exec(value.trim());
  if (!match) throw new Error('時刻は秒で入力してください。例 2 または 3/2');
  return time(Number(match[1]), Number(match[2] ?? 1));
};
const clipName = (clip: ClipV3) =>
  clip.kind === 'caption' ? clip.text : (names[clip.trackId] ?? clip.kind);

function link(id: string, actor: Actor) {
  return `/?${new URLSearchParams({ videoCollaboration: id, actor })}`;
}

async function connect(id: string, actor: Actor, signal: AbortSignal) {
  const key = `ep-video-collaboration:${id}:${actor}`;
  let credentials = JSON.parse(
    sessionStorage.getItem(key) ?? 'null',
  ) as EditorConnectionCredentials | null;
  if (!credentials) {
    const response = await fetch('/collaboration-api/editor/session', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifactId: id, actor, domain: 'video' }),
    });
    const result = (await response.json()) as EditorConnectionCredentials & { error?: string };
    if (!response.ok) throw new Error(result.error ?? '共有セッションを開けませんでした。');
    credentials = result;
    sessionStorage.setItem(key, JSON.stringify(credentials));
  }
  const adapter = new HttpEditorAdapter<VideoContentV3>(
    credentials.identity,
    credentials.token,
    'video',
    undefined,
    { immutableContent: true },
  );
  const session = new SharedEditorSession(videoTimelineCodec, adapter);
  const backup = `${key}:checkpoint`;
  try {
    const stored = sessionStorage.getItem(backup);
    if (stored) session.resume(JSON.parse(stored));
    await session.open();
    if (session.pendingCount) await session.reconnect();
    if (signal.aborted) throw new DOMException('Session closed', 'AbortError');
    return { session, backup };
  } catch (error) {
    session.suspend(() => {});
    throw error;
  }
}

export default function VideoCollaboration() {
  const params = new URLSearchParams(location.search);
  const id = params.get('videoCollaboration');
  const actor = params.get('actor') ?? 'A';
  if (id === 'new')
    return (
      <main className="video-coedit">
        <h1>動画の共同編集デモ</h1>
        <p>映像・音声はサンプルで、クリップの配置と字幕を共同編集できます。</p>
        <button onClick={() => location.assign(link(`video-${crypto.randomUUID()}`, 'A'))}>
          デモを始める
        </button>
        <a href="/">ライブラリへ戻る</a>
      </main>
    );
  if (!id || !/^video-[a-f0-9-]{36}$/.test(id) || !actorIDs.includes(actor as Actor))
    return (
      <main className="video-coedit">
        <p role="alert">共同編集のリンクを開けませんでした。</p>
        <a href="/">ライブラリへ戻る</a>
      </main>
    );
  return <Room id={id} actor={actor as Actor} />;
}

function Room({ id, actor }: { id: string; actor: Actor }) {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState('');
  const [, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let dispose = () => {};
    void connect(id, actor, controller.signal)
      .then(({ session, backup }) => {
        const retain = () => {
          try {
            sessionStorage.setItem(backup, JSON.stringify(session.captureCheckpoint()));
          } catch {
            setError('この端末に未反映の入力を保持できませんでした。');
          }
        };
        session.onChange = () => refresh((value) => value + 1);
        let polling = false;
        const timer = window.setInterval(async () => {
          if (polling || controller.signal.aborted) return;
          polling = true;
          try {
            await session.sync();
          } catch (cause) {
            if (!controller.signal.aborted) setError(String(cause));
          } finally {
            polling = false;
          }
        }, 400);
        window.addEventListener('pagehide', retain);
        dispose = () => {
          window.clearInterval(timer);
          window.removeEventListener('pagehide', retain);
          retain();
          session.suspend(() => {});
        };
        setSession(session);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause));
      });
    return () => {
      controller.abort();
      dispose();
    };
  }, [id, actor]);
  return (
    <main className="video-coedit">
      <header>
        <h1>動画の共同編集デモ</h1>
        <a href="/">ライブラリへ戻る</a>
      </header>
      {error && <p role="alert">{error}</p>}
      {session ? (
        <Editor id={id} actor={actor} session={session} retry={() => setError('')} />
      ) : (
        !error && <p role="status">共有セッションを開いています…</p>
      )}
    </main>
  );
}

function Editor({
  id,
  actor,
  session,
  retry,
}: {
  id: string;
  actor: Actor;
  session: Session;
  retry(): void;
}) {
  const [selectedId, setSelectedId] = useState('sample-picture');
  const [mode, setMode] = useState<Mode>('move');
  const [input, setInput] = useState<Input>();
  const [opId, setOpId] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const document = session.viewContent;
  const selected = document.sequence.clips.find((clip) => clip.id === selectedId);
  const duration = seconds(document.sequence.duration);
  const latestSave = session.savedVersions.at(-1);
  const blocked = busy || session.pendingCount > 0 || session.rejected.length > 0;
  const fields = input ?? (selected && defaults(session.confirmed, selected));
  useEffect(() => {
    if (!opId || session.lastReceipt?.operationId !== opId) return;
    if (session.lastReceipt.status === 'accepted') setInput(undefined);
    setOpId(undefined);
  }, [session.lastReceipt, opId]);
  useEffect(() => {
    if (!input && !session.pendingCount) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [input, session.pendingCount]);
  const choose = (clip: ClipV3) => {
    if (input || blocked) return;
    setSelectedId(clip.id);
    setMode(clip.kind === 'caption' ? 'caption-text' : 'move');
    setError('');
  };
  function update(field: 'start' | 'end' | 'text', value: string) {
    if (fields) setInput({ ...fields, [field]: value });
  }
  function apply(event: FormEvent) {
    event.preventDefault();
    if (!fields || !selected || blocked || session.readOnly || composing) return;
    setError('');
    try {
      const original = fields.base.content.sequence.clips.find((clip) => clip.id === selectedId);
      if (!original) throw new Error('選んだクリップがありません。');
      let edit: SharedVideoEdit;
      if (mode === 'caption-text') edit = { type: mode, clipId: original.id, text: fields.text };
      else if (mode === 'move')
        edit = {
          type: mode,
          clipId: original.id,
          delta: subtract(parse(fields.start), original.start),
        };
      else if (mode === 'trim')
        edit = {
          type: mode,
          clipId: original.id,
          start: parse(fields.start),
          end: parse(fields.end),
          independent: true,
        };
      else edit = splitVideoTimeline(fields.base.content, original, parse(fields.start));
      setOpId(session.executeActions([videoTimelineAction(edit)], fields.base).operationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    retry();
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  function reset(keep: boolean) {
    session.discardRetained();
    setComposing(false);
    setInput(keep && input ? { ...input, base: session.confirmed } : undefined);
    setError('');
  }
  return (
    <>
      <div className="video-coedit-toolbar">
        <p role="status">
          参加者 {actor} · {session.status}
        </p>
        <a href={link(id, actor === 'A' ? 'B' : 'A')} target="_blank" rel="noreferrer">
          別の参加者として開く
        </a>
        <button
          disabled={blocked || !!input || session.readOnly || !session.canUndo}
          onClick={() => void run(() => session.history('undo'))}
        >
          Undo
        </button>
        <button
          disabled={blocked || !!input || session.readOnly || !session.canRedo}
          onClick={() => void run(() => session.history('redo'))}
        >
          Redo
        </button>
        <button
          disabled={blocked || !!input || session.readOnly}
          onClick={() => void run(() => session.save('Video timeline'))}
        >
          保存する
        </button>
        <button disabled={busy} onClick={() => void run(() => session.reconnect())}>
          再接続
        </button>
      </div>
      {latestSave && <p>保存した版 r{latestSave.confirmedRevision}</p>}
      {(error || session.error) && <p role="alert">{error || session.error}</p>}
      <div className="video-coedit-grid">
        <section aria-label="タイムライン">
          <div className="video-coedit-ruler" aria-hidden="true">
            <span />
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i}>{(duration * i) / 5} s</span>
            ))}
          </div>
          {document.sequence.tracks.map((track) => (
            <div className="video-coedit-track" key={track.id}>
              <span>{names[track.id]}</span>
              <div className="video-coedit-lane" data-kind={track.kind}>
                {document.sequence.clips
                  .filter((clip) => clip.trackId === track.id)
                  .map((clip) => (
                    <button
                      key={clip.id}
                      type="button"
                      data-clip={clip.id}
                      aria-pressed={selectedId === clip.id}
                      title={`${clipName(clip)} · ${displayTime(clip.start)} s`}
                      style={{
                        left: `${(seconds(clip.start) / duration) * 100}%`,
                        width: `${(seconds(clip.duration) / duration) * 100}%`,
                      }}
                      disabled={!!input || blocked}
                      onClick={() => choose(clip)}
                    >
                      {clipName(clip)}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </section>
        <form aria-label="クリップを編集" onSubmit={apply}>
          <label>
            操作
            <select
              value={mode}
              disabled={!selected || !!input || blocked}
              onChange={(event) => setMode(event.currentTarget.value as Mode)}
            >
              {Object.entries(messages)
                .filter(([value]) => value !== 'caption-text' || selected?.kind === 'caption')
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          {selected && (
            <p data-testid="clip-range">
              {displayTime(selected.start)}–{displayTime(add(selected.start, selected.duration))} 秒
            </p>
          )}
          <fieldset disabled={!selected || blocked || session.readOnly}>
            {mode === 'caption-text' ? (
              <label>
                字幕
                <textarea
                  value={fields?.text ?? ''}
                  maxLength={4096}
                  onCompositionStart={() => setComposing(true)}
                  onCompositionEnd={() => setComposing(false)}
                  onChange={(event) => update('text', event.currentTarget.value)}
                />
              </label>
            ) : (
              <label>
                {mode === 'split' ? '分割位置（秒）' : '開始位置（秒）'}
                <input
                  value={fields?.start ?? ''}
                  onChange={(event) => update('start', event.currentTarget.value)}
                />
              </label>
            )}
            {mode === 'trim' && (
              <label>
                終了位置（秒）
                <input
                  value={fields?.end ?? ''}
                  onChange={(event) => update('end', event.currentTarget.value)}
                />
              </label>
            )}
            <button type="submit" disabled={!input || composing}>
              適用する
            </button>
          </fieldset>
          {(input || session.rejected.length > 0) && !session.pendingCount && (
            <button type="button" onClick={() => reset(false)}>
              入力を破棄
            </button>
          )}
          {input && session.rejected.length > 0 && !session.pendingCount && (
            <button type="button" onClick={() => reset(true)}>
              入力を残して共有版を読み直す
            </button>
          )}
        </form>
      </div>
    </>
  );
}

function defaults(base: Snapshot<VideoContentV3>, clip: ClipV3): Input {
  return {
    base,
    start: displayTime(clip.start),
    end: displayTime(add(clip.start, clip.duration)),
    text: clip.kind === 'caption' ? clip.text : '',
  };
}
