import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { newId } from '@editor-platform/artifact-core';
import type {
  Annotation,
  EditorCommand,
  ElementAddress,
  Region,
} from '@editor-platform/editor-core';
import { EditorLayout, type EditorLayoutProps } from '@editor-platform/editor-ui';
import {
  lineDiff,
  reviewRevision,
  reviewAnchorState,
  type ReviewContent,
  type ReviewVisibleSource,
  type ReviewResolvedSource,
} from './model';
import { VirtualRows } from './virtual';
import {
  comparisonCommand,
  diffHunks,
  diffLineWidth,
  diffMatches,
  extendRange,
  lineIndexOf,
  reviewRows,
  sideLine,
  type ReviewRange,
  type ReviewSide,
  type ReviewSources,
  type ReviewViewSettings,
} from './review-utils';
import { SourceVersionDialog, useRetainedSource } from './review-source';
import { ReviewInspector, ReviewNavigator, ReviewToolbar } from './review-panels';
import { CodeScrollbar, ComparisonSourcesDialog, DiffRowView } from './review-diff';
import './styles.css';
export { Highlight } from './review-diff';
export function ReviewSurface({
  content,
  execute,
  select,
  readOnly = false,
  layout,
  annotations: suppliedAnnotations = [],
  focusAddress,
  viewSettings,
  onViewSettingsChange,
  onSelectionClear,
  onVisibleSourceChange,
  resolveAnnotationSource,
  onRemapAnnotation,
}: {
  content: ReviewContent;
  onSelectionClear?(): void;
  onVisibleSourceChange?(source: ReviewVisibleSource): void;
  resolveAnnotationSource?(address: ElementAddress): Promise<ReviewResolvedSource | undefined>;
  onRemapAnnotation?(annotationId: string, region: Region, fileId: string): void;

  viewSettings?: ReviewViewSettings;
  onViewSettingsChange?(patch: ReviewViewSettings): void;
  execute: (cmd: EditorCommand<ReviewContent>) => void;
  select: (id: string, region?: Region) => void;
  readOnly?: boolean;
  layout?: Partial<EditorLayoutProps>;
  annotations?: Annotation[];
  focusAddress?: ElementAddress;
}) {
  const retained = useRetainedSource(resolveAnnotationSource);
  const notifications = useRef({ onSelectionClear, onVisibleSourceChange });
  notifications.current = { onSelectionClear, onVisibleSourceChange };
  const annotations = viewSettings?.annotations === false ? [] : suppliedAnnotations;
  const [fileId, setFileId] = useState(content.files[0]?.id),
    [splitChoice, setSplit] = useState<boolean>(),
    [wrapChoice, setWrap] = useState<boolean>();
  useEffect(() => {
    if (viewSettings?.split !== undefined) setSplit(viewSettings.split);
    if (viewSettings?.wrap !== undefined) setWrap(viewSettings.wrap);
  }, [viewSettings]);
  const body = useRef<HTMLDivElement>(null);
  const horizontal = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(window.innerWidth);
  const split = splitChoice ?? width >= 700;
  const wrap = wrapChoice ?? width < 700;
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    if (body.current) observer.observe(body.current);
    return () => observer.disconnect();
  }, []);
  const [sources, setSources] = useState<ReviewSources>();
  const [query, setQuery] = useState(''),
    [match, setMatch] = useState(0),
    [expanded, setExpanded] = useState(new Set<string>()),
    [hunk, setHunk] = useState(0);
  const [range, setRange] = useState<ReviewRange>(),
    [target, setTarget] = useState<number>();
  const file = content.files.find((f) => f.id === fileId) ?? content.files[0];
  const oldRevision = file ? reviewRevision(file, 'old') : '';
  const newRevision = file ? reviewRevision(file, 'new') : '';
  useLayoutEffect(() => {
    setRange(undefined);
    setTarget(undefined);
    retained.invalidate();
    notifications.current.onSelectionClear?.();
    if (file)
      notifications.current.onVisibleSourceChange?.({
        id: file.id,
        name: file.name,
        oldRevision,
        newRevision,
      });
  }, [file?.id, file?.name, oldRevision, newRevision]);
  const lines = useMemo(() => (file ? lineDiff(file.oldText, file.newText) : []), [file]);
  // A shared horizontal axis keeps both sides and newly virtualized rows aligned.
  const lineWidth = useMemo(() => diffLineWidth(lines), [lines]);
  useEffect(() => {
    if (horizontal.current) horizontal.current.scrollLeft = 0;
    body.current?.style.setProperty('--ep-code-scroll', '0px');
  }, [file?.id, wrap, split]);
  const hunks = useMemo(() => diffHunks(lines), [lines]);
  const matches = useMemo(() => diffMatches(lines, query), [lines, query]);
  const rows = useMemo(
    () => reviewRows(lines, expanded, query, target),
    [lines, expanded, query, target],
  );
  useEffect(() => {
    if (!focusAddress || reviewAnchorState(content, focusAddress) !== 'Current') return;
    const r = focusAddress.region;
    if (r?.type !== 'lines') return;
    setFileId(focusAddress.elementId);
    setRange({ start: r.start, end: r.end, side: r.side ?? 'new' });
    const source = content.files.find((f) => f.id === focusAddress.elementId)!;
    setTarget(lineIndexOf(lineDiff(source.oldText, source.newText), r));
  }, [focusAddress]);
  if (!file) return <p>No files in this review.</p>;
  function choose(index: number, side: ReviewSide, shift: boolean) {
    const number = sideLine(lines[index], side);
    if (!number) return;
    const next = extendRange(range, number, side, shift);
    setRange(next);
    select(file.id, { type: 'lines', ...next, revisionId: reviewRevision(file, side) });
  }
  function jumpHunk(next: number) {
    if (!hunks.length) return;
    const n = (next + hunks.length) % hunks.length;
    setHunk(n);
    setTarget(hunks[n]);
  }
  function showFile(id: string) {
    setFileId(id);
    setRange(undefined);
    setExpanded(new Set());
    setTarget(undefined);
    setHunk(0);
  }
  function focusLines(r: Region | undefined) {
    if (r?.type === 'lines') {
      setRange({ start: r.start, end: r.end, side: r.side ?? 'new' });
      setTarget(lineIndexOf(lines, r));
    }
    select(file.id, r);
  }
  function applySources(next: ReviewSources) {
    if (readOnly) return;
    execute(comparisonCommand(content, next));
    setRange(undefined);
    setFileId(next.id);
    setSources(undefined);
  }
  const columns = split ? 2 : 1;
  return (
    <EditorLayout
      viewKey="review"
      leftLabel="Review navigator"
      inspectorLabel="Review inspector"
      left={
        <ReviewNavigator
          files={content.files}
          fileId={file.id}
          readOnly={readOnly}
          hunks={hunks}
          lines={lines}
          onFile={showFile}
          onAddFile={() =>
            setSources({ id: newId('file'), name: 'new-file.ts', oldText: '', newText: '' })
          }
          onJump={jumpHunk}
        />
      }
      inspector={
        <ReviewInspector
          content={content}
          file={file}
          lines={lines}
          notice={retained.notice}
          sourceDialog={
            retained.resolved && (
              <SourceVersionDialog
                resolved={retained.resolved}
                excerpt={retained.excerpt}
                targetRef={retained.target}
                onClose={retained.close}
              />
            )
          }
          annotations={annotations}
          readOnly={readOnly}
          range={range}
          onOpenAnnotation={(address, current) =>
            retained.open(address, current, () => focusLines(address.region))
          }
          onRemapAnnotation={onRemapAnnotation}
        />
      }
      toolbar={
        <ReviewToolbar
          split={split}
          wrap={wrap}
          onSplitChange={(next) => {
            setSplit(next);
            onViewSettingsChange?.({ split: next });
          }}
          onWrapChange={(next) => {
            setWrap(next);
            onViewSettingsChange?.({ wrap: next });
          }}
          hasHunks={hunks.length > 0}
          onPreviousHunk={() => jumpHunk(hunk - 1)}
          onNextHunk={() => jumpHunk(hunk + 1)}
          query={query}
          onQueryChange={(next) => {
            setQuery(next);
            setMatch(0);
          }}
          match={match}
          matchCount={matches.length}
          onNextMatch={() => {
            const next = (match + 1) % matches.length;
            setMatch(next);
            setTarget(matches[next]);
          }}
          readOnly={readOnly}
          onSources={() =>
            setSources({
              id: file.id,
              name: file.name,
              oldText: file.oldText,
              newText: file.newText,
            })
          }
        />
      }
      {...layout}
    >
      <div ref={body} className={`ep-review ${wrap ? 'wrap' : ''}`}>
        <div className={`ep-diff-heading ${split ? 'split' : ''}`}>
          <span>Old · {file.name}</span>
          <span>New · {file.name}</span>
        </div>
        <VirtualRows
          key={file.id}
          rows={rows}
          rowKey={(r) => r.id}
          label="Code diff"
          focusIndex={target === undefined ? undefined : rows.findIndex((r) => r.index === target)}
          render={(row) => (
            <DiffRowView
              row={row}
              split={split}
              range={range}
              onChoose={choose}
              onExpand={(id) => setExpanded(new Set([...expanded, id]))}
            />
          )}
        />
        {!wrap && lineWidth > width / columns - 78 && (
          <CodeScrollbar
            scrollRef={horizontal}
            bodyRef={body}
            width={width}
            overflow={lineWidth - width / columns + 78}
          />
        )}
        {!lines.length && <p className="ep-empty">Both files are empty.</p>}
      </div>
      {sources && (
        <ComparisonSourcesDialog
          sources={sources}
          onChange={setSources}
          onApply={() => applySources(sources)}
          onClose={() => setSources(undefined)}
        />
      )}
    </EditorLayout>
  );
}
