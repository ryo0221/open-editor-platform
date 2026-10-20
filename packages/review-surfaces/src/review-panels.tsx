import type { ReactNode } from 'react';
import { ChevronUp, ChevronDown, Settings2, Search, Plus } from 'lucide-react';
import type { Annotation, ElementAddress, Region } from '@editor-platform/editor-core';
import { IconButton } from '@editor-platform/editor-ui';
import {
  reviewAnchorState,
  reviewRevision,
  type DiffLine,
  type ReviewContent,
  type ReviewFile,
} from './model';
import type { ReviewRange } from './review-utils';

export function ReviewNavigator({
  files,
  fileId,
  readOnly,
  hunks,
  lines,
  onFile,
  onAddFile,
  onJump,
}: {
  files: ReviewFile[];
  fileId: string;
  readOnly: boolean;
  hunks: number[];
  lines: DiffLine[];
  onFile(id: string): void;
  onAddFile(): void;
  onJump(hunk: number): void;
}) {
  return (
    <nav aria-label="Review files" className="ep-review-nav">
      {files.map((f) => (
        <button key={f.id} aria-pressed={f.id === fileId} onClick={() => onFile(f.id)}>
          {f.name}
        </button>
      ))}
      <button disabled={readOnly} onClick={onAddFile}>
        <Plus size={14} /> Add comparison file
      </button>
      <h3>Changes</h3>
      {hunks.map((i, n) => (
        <button key={i} onClick={() => onJump(n)}>
          Change {n + 1} · line {lines[i].newLine ?? lines[i].oldLine}
        </button>
      ))}
    </nav>
  );
}

function ReviewAnnotationItem({
  annotation: a,
  content,
  file,
  readOnly,
  range,
  onOpen,
  onRemapAnnotation,
}: {
  annotation: Annotation;
  content: ReviewContent;
  file: ReviewFile;
  readOnly: boolean;
  range: ReviewRange | undefined;
  onOpen(address: ElementAddress, current: boolean): Promise<void>;
  onRemapAnnotation?(annotationId: string, region: Region, fileId: string): void;
}) {
  const address = a.anchor.addresses.find((x) => x.elementId === file.id)!;
  const state = reviewAnchorState(content, address);
  return (
    <div>
      <button
        style={a.color ? { borderInlineStart: `3px solid ${a.color}` } : undefined}
        onClick={() => onOpen(address, state === 'Current')}
      >
        {a.comments[0]?.body} · {a.resolved ? 'Resolved' : state}
      </button>
      {state !== 'Current' && (
        <button
          disabled={readOnly || !range || !onRemapAnnotation}
          onClick={() => {
            if (range)
              onRemapAnnotation?.(
                a.id,
                { type: 'lines', ...range, revisionId: reviewRevision(file, range.side) },
                file.id,
              );
          }}
        >
          Remap annotation to selected current lines
        </button>
      )}
    </div>
  );
}

export function ReviewInspector({
  content,
  file,
  lines,
  notice,
  sourceDialog,
  annotations,
  readOnly,
  range,
  onOpenAnnotation,
  onRemapAnnotation,
}: {
  content: ReviewContent;
  file: ReviewFile;
  lines: DiffLine[];
  notice: string;
  sourceDialog: ReactNode;
  annotations: Annotation[];
  readOnly: boolean;
  range: ReviewRange | undefined;
  onOpenAnnotation(address: ElementAddress, current: boolean): Promise<void>;
  onRemapAnnotation?(annotationId: string, region: Region, fileId: string): void;
}) {
  return (
    <div className="ep-review-info">
      <h3>{file.name}</h3>
      <p>
        {lines.filter((l) => l.type === 'added').length} added ·{' '}
        {lines.filter((l) => l.type === 'removed').length} removed
      </p>
      <p>Click a line; Shift-click to select a range on the same side.</p>
      <h3>Anchored comments</h3>
      {notice && <p role="status">{notice}</p>}
      {sourceDialog}
      {annotations
        .filter((a) => a.anchor.addresses.some((x) => x.elementId === file.id))
        .map((a) => (
          <ReviewAnnotationItem
            key={a.id}
            annotation={a}
            content={content}
            file={file}
            readOnly={readOnly}
            range={range}
            onOpen={onOpenAnnotation}
            onRemapAnnotation={onRemapAnnotation}
          />
        ))}
    </div>
  );
}

export function ReviewToolbar({
  split,
  wrap,
  onSplitChange,
  onWrapChange,
  hasHunks,
  onPreviousHunk,
  onNextHunk,
  query,
  onQueryChange,
  match,
  matchCount,
  onNextMatch,
  readOnly,
  onSources,
}: {
  split: boolean;
  wrap: boolean;
  onSplitChange(split: boolean): void;
  onWrapChange(wrap: boolean): void;
  hasHunks: boolean;
  onPreviousHunk(): void;
  onNextHunk(): void;
  query: string;
  onQueryChange(query: string): void;
  match: number;
  matchCount: number;
  onNextMatch(): void;
  readOnly: boolean;
  onSources(): void;
}) {
  return (
    <>
      <select
        aria-label="Diff layout"
        value={split ? 'split' : 'unified'}
        onChange={(e) => onSplitChange(e.target.value === 'split')}
      >
        <option value="split">Split</option>
        <option value="unified">Unified</option>
      </select>
      <label className="ep-toolbar-check">
        <input type="checkbox" checked={wrap} onChange={(e) => onWrapChange(e.target.checked)} />{' '}
        Wrap lines
      </label>
      <IconButton
        icon={ChevronUp}
        label="Previous change"
        disabled={!hasHunks}
        onClick={onPreviousHunk}
      />
      <IconButton
        icon={ChevronDown}
        label="Next change"
        disabled={!hasHunks}
        onClick={onNextHunk}
      />
      <input
        className="ep-review-search"
        aria-label="Search diff"
        placeholder="Search diff"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <IconButton
        icon={Search}
        label="Next search match"
        disabled={!matchCount}
        onClick={onNextMatch}
      />
      <span className="ep-muted">{matchCount ? `${match + 1}/${matchCount}` : ''}</span>
      <span className="ep-spacer" />
      <IconButton
        icon={Settings2}
        label="Comparison sources"
        disabled={readOnly}
        onClick={onSources}
      />
    </>
  );
}
