import { useRef, useState } from 'react';
import { command, type Annotation, type EditorCommand } from '@editor-platform/editor-core';
import { Dialog } from '@editor-platform/editor-ui';
import { originalBytes, type FileContent } from './model';
import { decodeFileText, type FileTextEncoding } from './text-decode';
import { acceptedFileMime, isAnchoredTo, readFileContent } from './viewer-utils';

const ENCODINGS = ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'shift_jis'] as const;

export function useSourceReplacement({
  content,
  readOnly,
  execute,
  onOpenAsNew,
  setError,
}: {
  content: FileContent;
  readOnly: boolean;
  execute: (cmd: EditorCommand<FileContent>) => void | boolean;
  onOpenAsNew?(source: FileContent): Promise<void> | void;
  setError(error: string): void;
}) {
  const [replacement, setReplacement] = useState<FileContent>();
  const [open, setOpen] = useState(false);
  const [encoding, setEncoding] = useState<FileTextEncoding>('auto');
  const currentEncoding = useRef<FileTextEncoding>('auto');
  const baseSource = useRef<{ id: string; data: string } | undefined>(undefined);
  function begin() {
    baseSource.current = { id: content.id, data: content.data };
    setReplacement(undefined);
    setError('');
    setOpen(true);
  }
  function close() {
    setOpen(false);
    setReplacement(undefined);
  }
  function changeEncoding(nextEncoding: FileTextEncoding) {
    currentEncoding.current = nextEncoding;
    setEncoding(nextEncoding);
    if (!replacement?.mime.startsWith('text/')) return;
    try {
      setReplacement({
        ...replacement,
        data: decodeFileText(originalBytes(replacement), replacement.name, nextEncoding),
      });
      setError('');
    } catch (error) {
      setReplacement(undefined);
      setError(`文字コードを確認して原本を選び直してください: ${String(error)}`);
    }
  }
  async function openFile(file: File) {
    if (readOnly) return;
    const accepted = acceptedFileMime(file);
    if ('error' in accepted) {
      setError(accepted.error);
      return;
    }
    const opened = await readFileContent(file, accepted.mime, () => currentEncoding.current);
    if (opened.error !== undefined) {
      setError(opened.error);
      return;
    }
    setReplacement(opened.content);
    setError('');
  }
  function confirm() {
    if (!replacement) return;
    const next = replacement;
    try {
      if (
        execute(
          command('file.replace', 'Replace source', (current) => {
            if (current.id !== baseSource.current?.id || current.data !== baseSource.current?.data)
              throw new Error('原本が変更されました。置換を開き直してください。');
            return next;
          }),
        ) !== false
      )
        close();
    } catch (error) {
      setError(String(error));
    }
  }
  async function openAsNew() {
    if (replacement) {
      try {
        await onOpenAsNew?.(replacement);
        setOpen(false);
      } catch (error) {
        setError(String(error));
      }
    }
  }
  return {
    open,
    replacement,
    encoding,
    begin,
    close,
    changeEncoding,
    openFile,
    confirm,
    openAsNew,
  };
}

export function ReplaceSourceDialog({
  content,
  annotations,
  encoding,
  replacement,
  error,
  readOnly,
  canOpenAsNew,
  onEncodingChange,
  onChooseFile,
  onConfirm,
  onOpenAsNew,
  onClose,
}: {
  content: FileContent;
  annotations: Annotation[];
  encoding: FileTextEncoding;
  replacement: FileContent | undefined;
  error: string;
  readOnly: boolean;
  canOpenAsNew: boolean;
  onEncodingChange(encoding: FileTextEncoding): void;
  onChooseFile(): void;
  onConfirm(): void;
  onOpenAsNew(): Promise<void>;
  onClose(): void;
}) {
  return (
    <Dialog title="Replace source" onClose={onClose}>
      <p>
        現在の原本: {content.name} · {content.mime} · {content.size} bytes
      </p>
      <p>
        {annotations.filter((annotation) => isAnchoredTo(annotation, content.id)).length}{' '}
        annotations may become Orphan. 新しい原本へ自動では紐付けません。置換はUndoで戻せます。
      </p>
      <label>
        Text encoding
        <select
          aria-label="File text encoding"
          value={encoding}
          onChange={(event) => onEncodingChange(event.target.value as FileTextEncoding)}
        >
          {ENCODINGS.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <button onClick={onChooseFile}>Choose replacement file</button>
      {replacement && (
        <p>
          新しい原本: {replacement.name} · {replacement.mime}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button disabled={readOnly || !replacement} onClick={onConfirm}>
        Confirm source replacement
      </button>
      <button
        disabled={readOnly || !replacement || !canOpenAsNew}
        title={!canOpenAsNew ? 'Hostは新しい成果物の作成を提供していません。' : undefined}
        onClick={onOpenAsNew}
      >
        Open as new artifact
      </button>
      <button onClick={onClose}>Cancel replacement</button>
    </Dialog>
  );
}
