import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Scan,
  RotateCw,
  MousePointer2,
  Hand,
  Search,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { IconButton, Menu, CommitInput } from '@editor-platform/editor-ui';
import { createFile, type FileContent } from './model';
import type { FileTool } from './viewer-utils';

export function PdfToolbarControls({
  query,
  onQueryChange,
  matchCount,
  truncated,
  onNextMatch,
  pdf,
  page,
  onPage,
  onCommitPage,
}: {
  query: string;
  onQueryChange(query: string): void;
  matchCount: number;
  truncated: boolean;
  onNextMatch(): void;
  pdf: PDFDocumentProxy | undefined;
  page: number;
  onPage(page: number): void;
  onCommitPage(value: string): void;
}) {
  return (
    <>
      <input
        aria-label="Search PDF text"
        placeholder="PDF内の文字を検索"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <button disabled={!matchCount} onClick={onNextMatch}>
        Next PDF text match
      </button>
      <span role="status">
        {matchCount} text matches{truncated ? ' (partial)' : ''}
      </span>
      <IconButton
        icon={ChevronLeft}
        label="Previous PDF page"
        disabled={!pdf || page <= 1}
        onClick={() => onPage(page - 1)}
      />
      <CommitInput
        label="PDF page"
        type="number"
        min={1}
        max={pdf?.numPages ?? 1}
        value={page}
        onCommit={onCommitPage}
      />
      <span className="ep-muted">/ {pdf?.numPages ?? '…'}</span>
      <IconButton
        icon={ChevronRight}
        label="Next PDF page"
        disabled={!pdf || page >= pdf.numPages}
        onClick={() => onPage(page + 1)}
      />
    </>
  );
}

const ZOOM_PRESETS = [0.25, 0.5, 1, 1.5, 2, 3, 4];

export function AssetToolbarControls({
  isPdf,
  zoom,
  onZoom,
  onFit,
  onRotate,
  tool,
  onTool,
  onSelectPage,
}: {
  isPdf: boolean;
  zoom: number;
  onZoom(next: number): void;
  onFit(mode: 'page' | 'width'): void;
  onRotate(): void;
  tool: FileTool;
  onTool(tool: FileTool): void;
  onSelectPage(): void;
}) {
  return (
    <>
      <IconButton icon={ZoomOut} label="Zoom out" onClick={() => onZoom(zoom / 1.2)} />
      <select
        aria-label="File zoom"
        value={String(zoom)}
        onChange={(e) => onZoom(Number(e.target.value))}
      >
        <option value={String(zoom)}>{Math.round(zoom * 100)}%</option>
        {ZOOM_PRESETS.filter((v) => v !== zoom).map((v) => (
          <option key={v} value={v}>
            {v * 100}%
          </option>
        ))}
      </select>
      <IconButton icon={ZoomIn} label="Zoom in" onClick={() => onZoom(zoom * 1.2)} />
      <IconButton
        icon={Scan}
        label={isPdf ? 'Fit PDF page' : 'Fit image'}
        onClick={() => onFit('page')}
      />
      {isPdf && <button onClick={() => onFit('width')}>Fit width</button>}
      <IconButton icon={RotateCw} label="Rotate view clockwise" onClick={onRotate} />
      <IconButton
        icon={Hand}
        label="Pan file"
        aria-pressed={tool === 'pan'}
        onClick={() => onTool('pan')}
      />
      <IconButton
        icon={MousePointer2}
        label="Select file region"
        aria-pressed={tool === 'region'}
        onClick={() => onTool('region')}
      />
      {isPdf && (
        <>
          <button onClick={onSelectPage}>Select page</button>
          <button aria-pressed={tool === 'text'} onClick={() => onTool('text')}>
            Select PDF text
          </button>
        </>
      )}
    </>
  );
}

export function TextToolbarControls({
  query,
  onQueryChange,
  hasMatches,
  onNextMatch,
  wrap,
  onWrapChange,
}: {
  query: string;
  onQueryChange(query: string): void;
  hasMatches: boolean;
  onNextMatch(): void;
  wrap: boolean;
  onWrapChange(wrap: boolean): void;
}) {
  return (
    <>
      <input
        aria-label="Search file"
        placeholder="Search text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <IconButton
        icon={Search}
        label="Next file match"
        disabled={!hasMatches}
        onClick={onNextMatch}
      />
      <label className="ep-toolbar-check">
        <input type="checkbox" checked={wrap} onChange={(e) => onWrapChange(e.target.checked)} />{' '}
        Wrap lines
      </label>
    </>
  );
}

export function SampleFilesMenu({
  readOnly,
  execute,
}: {
  readOnly: boolean;
  execute: (cmd: EditorCommand<FileContent>) => void | boolean;
}) {
  return (
    <Menu label="Sample files">
      {(['text', 'image', 'pdf'] as const).map((kind) => (
        <button
          key={kind}
          disabled={readOnly}
          onClick={() => {
            const demo = createFile(kind);
            execute(command('file.sample', `Open sample ${kind}`, () => demo));
          }}
        >
          Demo {kind.toUpperCase()}
        </button>
      ))}
    </Menu>
  );
}
