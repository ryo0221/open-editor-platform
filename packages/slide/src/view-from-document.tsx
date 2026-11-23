import { useId, useLayoutEffect, useRef, useState } from 'react';
import { formatLiveValue } from '@editor-platform/artifact-references';
import type { Slide } from './model';

export type SlideDocumentSource =
  | { kind: 'saved'; artifactId: string; versionId: string; hash: string }
  | { kind: 'file'; file: File; versionId?: string };
export interface SlideDocumentOption {
  id: string;
  name: string;
  versions: { id: string; label: string; hash: string }[];
}
export interface SlideDocumentPreview {
  sourceLabel: string;
  destinationLabel: string;
  firstPage: number;
  pages: readonly Slide[];
  figures: ReadonlyMap<string, string>;
  commit(signal: AbortSignal, origin?: { proposalId: string }): Promise<void>;
}
export interface SlideDocumentHost {
  documents: SlideDocumentOption[];
  destination: string;
  canCreate: boolean;
  canAppend: boolean;
  appendReason?: string;
  fileVersions(file: File): Promise<SlideDocumentOption['versions']>;
  prepare(
    source: SlideDocumentSource,
    destination: 'new' | 'append',
    name: string,
    signal: AbortSignal,
  ): Promise<SlideDocumentPreview>;
}

export function SlideDocumentPages({ preview }: { preview: SlideDocumentPreview }) {
  return (
    <>
      <p>
        {preview.sourceLabel} ／ {preview.destinationLabel}
      </p>
      <p>生成ページ {preview.pages.length} 枚</p>
      <ol start={preview.firstPage}>
        {preview.pages.map((page) => (
          <li key={page.id}>
            <details>
              <summary>{page.title}</summary>
              {page.objects.map((object) => {
                const quote = object.liveQuote;
                if (!quote) return <p key={object.id}>{object.text}</p>;
                const { presentation, source, snapshot } = quote;
                const figureSrc = preview.figures.get(object.id);
                return (
                  <p key={object.id}>
                    <strong>
                      {presentation.kind === 'value'
                        ? formatLiveValue(presentation)
                        : presentation.label}
                    </strong>
                    <br />
                    引用元 {source.artifactId} ／ 保存版 {snapshot.versionId}
                    {presentation.kind === 'figure' && figureSrc && (
                      <img src={figureSrc} alt={presentation.label} />
                    )}
                  </p>
                );
              })}
            </details>
          </li>
        ))}
      </ol>
    </>
  );
}

export function SlideDocumentDialog({
  host,
  opening,
  isComposing,
  close,
}: {
  host: SlideDocumentHost;
  opening: { opener?: HTMLButtonElement | null; fallback?: HTMLButtonElement | null };
  isComposing(): boolean;
  close(): void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const errorFocus = useRef<HTMLDivElement>(null);
  const pending = useRef<AbortController | undefined>(undefined);
  const [sourceId, setSourceId] = useState(host.documents[0]?.id ?? '');
  const [file, setFile] = useState<File>();
  const [fileOptions, setFileOptions] = useState<SlideDocumentOption['versions']>([]);
  const [versionId, setVersionId] = useState('');
  const [destination, setDestination] = useState<'new' | 'append'>(
    host.canCreate ? 'new' : 'append',
  );
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<SlideDocumentPreview>();
  const [busy, setBusy] = useState<'reading' | 'preview' | 'commit'>();
  const [error, setError] = useState('');
  const option = host.documents.find((document) => document.id === sourceId);
  const options = sourceId === '' ? fileOptions : (option?.versions ?? []);
  const selectedVersion =
    options.find(({ id }) => id === versionId) ?? (sourceId ? options[0] : undefined);
  const proposedName =
    name.trim() ||
    option?.name ||
    file?.name.replace(/(?:\.artifact)?\.json$/i, '') ||
    'Slide Deck';
  const source: SlideDocumentSource | undefined = !sourceId
    ? file && { kind: 'file', file, versionId: selectedVersion?.id }
    : selectedVersion && {
        kind: 'saved',
        artifactId: sourceId,
        versionId: selectedVersion.id,
        hash: selectedVersion.hash,
      };
  const allowed = destination === 'new' ? host.canCreate : host.canAppend;
  useLayoutEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    modal?.querySelector<HTMLElement>('h2')?.focus();
    return () => {
      pending.current?.abort();
      modal?.close();
      const { opener, fallback } = opening;
      (opener?.isConnected && opener.getClientRects().length ? opener : fallback)?.focus();
    };
  }, [opening]);
  useLayoutEffect(() => {
    if (error) errorFocus.current?.focus();
  }, [error]);

  function reset() {
    setPreview(undefined);
    setError('');
  }
  async function run(
    kind: NonNullable<typeof busy>,
    action: (signal: AbortSignal) => Promise<void>,
  ) {
    if (isComposing() || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(kind);
    setError('');
    try {
      await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (kind === 'preview') setPreview(undefined);
        setError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
      if (pending.current === controller) pending.current = undefined;
    }
  }
  function dismiss() {
    if (!isComposing() && busy !== 'commit') close();
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby={id}
      className="ep-dialog slide-document-dialog"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <div className="ep-dialog-heading">
        <h2 id={id} tabIndex={-1}>
          文書から作る
        </h2>
      </div>
      <fieldset disabled={!!busy}>
        <legend>文書</legend>
        <label className="ep-field">
          文書を選ぶ
          <select
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
              setVersionId('');
              reset();
            }}
          >
            {host.documents.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.name}
              </option>
            ))}
            <option value="">ローカル JSON</option>
          </select>
        </label>
        {!sourceId && (
          <label className="ep-field">
            Document JSON
            <input
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                reset();
                setFile(undefined);
                setFileOptions([]);
                setVersionId('');
                if (file)
                  void run('reading', async (signal) => {
                    const versions = await host.fileVersions(file);
                    if (!signal.aborted) {
                      setFile(file);
                      setFileOptions(versions);
                    }
                  });
              }}
            />
          </label>
        )}
        {options.length > 0 && (
          <label className="ep-field">
            保存版
            <select
              value={selectedVersion?.id ?? ''}
              onChange={(event) => {
                setVersionId(event.target.value);
                reset();
              }}
            >
              {!sourceId && <option value="">下書き</option>}
              {options.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
      </fieldset>
      <fieldset disabled={!!busy}>
        <legend>作成先</legend>
        <label>
          <input
            type="radio"
            name={id}
            checked={destination === 'new'}
            disabled={!host.canCreate}
            onChange={() => {
              setDestination('new');
              reset();
            }}
          />
          新しいデッキ
        </label>
        <label>
          <input
            type="radio"
            name={id}
            checked={destination === 'append'}
            disabled={!host.canAppend}
            onChange={() => {
              setDestination('append');
              reset();
            }}
          />
          このデッキの末尾に追加
        </label>
        {host.appendReason && <p>{host.appendReason}</p>}
        {destination === 'new' ? (
          <label className="ep-field">
            デッキ名
            <input
              value={name}
              placeholder={proposedName}
              onChange={(event) => {
                setName(event.target.value);
                reset();
              }}
            />
          </label>
        ) : (
          <p>{host.destination}</p>
        )}
      </fieldset>
      <section aria-label="プレビュー">
        {error && (
          <div ref={errorFocus} role="alert" tabIndex={-1}>
            {error}
          </div>
        )}
        {preview && <SlideDocumentPages preview={preview} />}
      </section>
      <footer>
        <button type="button" onClick={dismiss} disabled={busy === 'commit'}>
          閉じる
        </button>
        <button
          type="button"
          disabled={!source || !allowed || !!busy}
          onClick={() => {
            if (!source) return;
            reset();
            void run('preview', async (signal) => {
              const result = await host.prepare(source, destination, proposedName, signal);
              if (!signal.aborted) setPreview(result);
            });
          }}
        >
          プレビュー
        </button>
        <button
          type="button"
          disabled={!allowed || !preview || !!busy}
          onClick={() => {
            if (preview)
              void run('commit', async (signal) => {
                await preview.commit(signal);
                close();
              });
          }}
        >
          {destination === 'new' ? 'デッキを作る' : '末尾に追加'}
        </button>
      </footer>
    </dialog>
  );
}
