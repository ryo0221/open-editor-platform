import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, Settings2, Search, Plus } from 'lucide-react';
import { newId } from '@editor-platform/artifact-core';
import {
  command,
  type Annotation,
  type EditorCommand,
  type ElementAddress,
  type Region,
} from '@editor-platform/editor-core';
import {
  EditorLayout,
  IconButton,
  Dialog,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import {
  lineDiff,
  replaceComparison,
  reviewRevision,
  reviewAddressRevision,
  reviewAnchorState,
  type DiffLine,
  type ReviewContent,
  type ReviewVisibleSource,
  type ReviewResolvedSource,
} from './model';
import { VirtualRows } from './virtual';
import './styles.css';
export function Highlight({ text }: { text: string }) {
  return (
    <>
      {text
        .split(
          /(\b(?:export|function|return|const|let|import|from|if|string|number|class|async|await)\b|"[^"]*"|'[^']*'|`[^`]*`)/g,
        )
        .map((t, i) => (
          <span
            key={i}
            className={
              /^(export|function|return|const|let|import|from|if|string|number|class|async|await)$/.test(
                t,
              )
                ? 'ep-token-keyword'
                : /^["'`]/.test(t)
                  ? 'ep-token-string'
                  : ''
            }
          >
            {t}
          </span>
        ))}
    </>
  );
}
type ReviewRow = { id: string; line?: DiffLine; index: number; count?: number };
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

  viewSettings?: { split?: boolean; wrap?: boolean; annotations?: boolean };
  onViewSettingsChange?(patch: { split?: boolean; wrap?: boolean; annotations?: boolean }): void;
  execute: (cmd: EditorCommand<ReviewContent>) => void;
  select: (id: string, region?: Region) => void;
  readOnly?: boolean;
  layout?: Partial<EditorLayoutProps>;
  annotations?: Annotation[];
  focusAddress?: ElementAddress;
}) {
  const [sourceNotice, setSourceNotice] = useState('');
  const [resolvedSource, setResolvedSource] = useState<{
    source: ReviewResolvedSource;
    address: ElementAddress;
  }>();
  const sourceTarget = useRef<HTMLElement | null>(null);
  const sourceExcerpt = useMemo(() => {
    const region = resolvedSource?.address.region;
    if (!resolvedSource || region?.type !== 'lines') return undefined;
    const lines = resolvedSource.source.text.split('\n');
    return {
      before: region.start > 1 ? lines.slice(0, region.start - 1).join('\n') + '\n' : '',
      selected: lines.slice(region.start - 1, region.end).join('\n'),
      after: region.end < lines.length ? '\n' + lines.slice(region.end).join('\n') : '',
    };
  }, [resolvedSource]);
  useEffect(() => {
    sourceTarget.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [resolvedSource]);
  const resolutionSequence = useRef(0);
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
  const [sources, setSources] = useState<{
    id: string;
    name: string;
    oldText: string;
    newText: string;
  }>();
  const [query, setQuery] = useState(''),
    [match, setMatch] = useState(0),
    [expanded, setExpanded] = useState(new Set<string>()),
    [hunk, setHunk] = useState(0);
  const [range, setRange] = useState<{ start: number; end: number; side: 'old' | 'new' }>(),
    [target, setTarget] = useState<number>();
  const file = content.files.find((f) => f.id === fileId) ?? content.files[0];
  const oldRevision = file ? reviewRevision(file, 'old') : '';
  const newRevision = file ? reviewRevision(file, 'new') : '';
  useLayoutEffect(() => {
    setRange(undefined);
    setTarget(undefined);
    setSourceNotice('');
    resolutionSequence.current++;
    setResolvedSource(undefined);
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
  const lineWidth = useMemo(
    () =>
      Math.max(
        0,
        ...lines.map((line) =>
          Array.from(line.text).reduce(
            (n, char) => n + (char === '\t' ? 8 : char.codePointAt(0)! > 255 ? 2 : 1),
            0,
          ),
        ),
      ) * 8,
    [lines],
  );
  useEffect(() => {
    if (horizontal.current) horizontal.current.scrollLeft = 0;
    body.current?.style.setProperty('--ep-code-scroll', '0px');
  }, [file?.id, wrap, split]);
  const hunks = useMemo(
    () =>
      lines.reduce<number[]>((all, line, i) => {
        if (line.type !== 'context' && (i === 0 || lines[i - 1].type === 'context')) all.push(i);
        return all;
      }, []),
    [lines],
  );
  const matches = useMemo(
    () =>
      query
        ? lines.flatMap((l, i) =>
            l.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [i] : [],
          )
        : [],
    [lines, query],
  );
  const rows = useMemo(() => {
    const keep = new Set<number>();
    if (target !== undefined)
      for (let i = Math.max(0, target - 3); i <= Math.min(lines.length - 1, target + 3); i++)
        keep.add(i);
    lines.forEach((l, i) => {
      if (
        l.type !== 'context' ||
        (query && l.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      )
        for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) keep.add(j);
    });
    const result: ReviewRow[] = [];
    let i = 0;
    while (i < lines.length) {
      if (keep.has(i)) {
        result.push({ id: `line-${i}`, line: lines[i], index: i });
        i++;
      } else {
        const start = i;
        while (i < lines.length && !keep.has(i)) i++;
        const id = `gap-${start}-${i}`;
        if (expanded.has(id))
          for (let j = start; j < i; j++)
            result.push({ id: `line-${j}`, line: lines[j], index: j });
        else result.push({ id, index: start, count: i - start });
      }
    }
    return result;
  }, [lines, expanded, query, target]);
  useEffect(() => {
    if (!focusAddress || reviewAnchorState(content, focusAddress) !== 'Current') return;
    const r = focusAddress.region;
    if (r?.type !== 'lines') return;
    setFileId(focusAddress.elementId);
    setRange({ start: r.start, end: r.end, side: r.side ?? 'new' });
    const source = content.files.find((f) => f.id === focusAddress.elementId)!;
    const index = lineDiff(source.oldText, source.newText).findIndex(
      (l) => (r.side === 'old' ? l.oldLine : l.newLine) === r.start,
    );
    setTarget(index);
  }, [focusAddress]);
  if (!file) return <p>No files in this review.</p>;
  function choose(index: number, side: 'old' | 'new', shift: boolean) {
    const line = lines[index],
      number = side === 'old' ? line.oldLine : line.newLine;
    if (!number) return;
    const next =
      shift && range?.side === side
        ? { start: Math.min(range.start, number), end: Math.max(range.end, number), side }
        : { start: number, end: number, side };
    setRange(next);
    select(file.id, { type: 'lines', ...next, revisionId: reviewRevision(file, side) });
  }
  function jumpHunk(next: number) {
    if (!hunks.length) return;
    const n = (next + hunks.length) % hunks.length;
    setHunk(n);
    setTarget(hunks[n]);
  }
  const cell = (row: ReviewRow, side: 'old' | 'new') => {
    const line = row.line!,
      n = side === 'old' ? line.oldLine : line.newLine;
    if (!n) return <div className="ep-diff-cell ep-diff-empty" />;
    return (
      <button
        className={`ep-diff-cell ${line.type} ${range?.side === side && n >= range.start && n <= range.end ? 'selected' : ''}`}
        aria-label={`${line.type} ${side} line ${n}`}
        onClick={(e) => choose(row.index, side, e.shiftKey)}
      >
        <span className="ep-line-number">{n}</span>
        <span className="ep-line-sign">
          {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
        </span>
        <code>
          <span className="ep-code-text">
            <Highlight text={line.text || ' '} />
          </span>
        </code>
      </button>
    );
  };
  return (
    <EditorLayout
      viewKey="review"
      leftLabel="Review navigator"
      inspectorLabel="Review inspector"
      left={
        <nav aria-label="Review files" className="ep-review-nav">
          {content.files.map((f) => (
            <button
              key={f.id}
              aria-pressed={f.id === file.id}
              onClick={() => {
                setFileId(f.id);
                setRange(undefined);
                setExpanded(new Set());
                setTarget(undefined);
                setHunk(0);
              }}
            >
              {f.name}
            </button>
          ))}
          <button
            disabled={readOnly}
            onClick={() =>
              setSources({ id: newId('file'), name: 'new-file.ts', oldText: '', newText: '' })
            }
          >
            <Plus size={14} /> Add comparison file
          </button>
          <h3>Changes</h3>
          {hunks.map((i, n) => (
            <button key={i} onClick={() => jumpHunk(n)}>
              Change {n + 1} · line {lines[i].newLine ?? lines[i].oldLine}
            </button>
          ))}
        </nav>
      }
      inspector={
        <div className="ep-review-info">
          <h3>{file.name}</h3>
          <p>
            {lines.filter((l) => l.type === 'added').length} added ·{' '}
            {lines.filter((l) => l.type === 'removed').length} removed
          </p>
          <p>Click a line; Shift-click to select a range on the same side.</p>
          <h3>Anchored comments</h3>
          {sourceNotice && <p role="status">{sourceNotice}</p>}
          {resolvedSource && (
            <Dialog title="Annotation source version" onClose={() => setResolvedSource(undefined)}>
              <p>
                {resolvedSource.source.name} · {resolvedSource.source.side} · source{' '}
                {resolvedSource.source.revisionId} · lines{' '}
                {resolvedSource.address.region?.type === 'lines'
                  ? `${resolvedSource.address.region.start}–${resolvedSource.address.region.end}`
                  : ''}
              </p>
              <pre className="ep-review-retained-source">
                {sourceExcerpt?.before}
                <mark ref={sourceTarget}>{sourceExcerpt?.selected}</mark>
                {sourceExcerpt?.after}
              </pre>
            </Dialog>
          )}
          {annotations
            .filter((a) => a.anchor.addresses.some((x) => x.elementId === file.id))
            .map((a) => {
              const address = a.anchor.addresses.find((x) => x.elementId === file.id)!;
              const state = reviewAnchorState(content, address);
              return (
                <div key={a.id}>
                  <button
                    style={a.color ? { borderInlineStart: `3px solid ${a.color}` } : undefined}
                    onClick={async () => {
                      const sequence = ++resolutionSequence.current;
                      setResolvedSource(undefined);
                      setSourceNotice('');
                      if (state === 'Current') {
                        const r = address.region;
                        if (r?.type === 'lines') {
                          setRange({ start: r.start, end: r.end, side: r.side ?? 'new' });
                          setTarget(
                            lines.findIndex(
                              (l) => (r.side === 'old' ? l.oldLine : l.newLine) === r.start,
                            ),
                          );
                        }
                        select(file.id, r);
                      } else {
                        try {
                          const source = await resolveAnnotationSource?.(address);
                          if (sequence !== resolutionSequence.current) return;
                          const r = address.region;
                          if (
                            source &&
                            r?.type === 'lines' &&
                            source.revisionId === reviewAddressRevision(address) &&
                            source.side === (r.side ?? 'new') &&
                            Number.isInteger(r.start) &&
                            Number.isInteger(r.end) &&
                            r.start >= 1 &&
                            r.end >= r.start &&
                            r.end <= source.text.split('\n').length
                          ) {
                            setResolvedSource({ source, address });
                          } else
                            setSourceNotice(
                              'この注釈の旧原本版をHostから取得できません。現在の対象行を選び、明示的に再紐付けしてください。',
                            );
                        } catch {
                          if (sequence === resolutionSequence.current)
                            setSourceNotice(
                              '旧原本版の取得に失敗しました。再試行、または現在の行への再紐付けを選んでください。',
                            );
                        }
                      }
                    }}
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
                            {
                              type: 'lines',
                              ...range,
                              revisionId: reviewRevision(file, range.side),
                            },
                            file.id,
                          );
                      }}
                    >
                      Remap annotation to selected current lines
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      }
      toolbar={
        <>
          <select
            aria-label="Diff layout"
            value={split ? 'split' : 'unified'}
            onChange={(e) => {
              const split = e.target.value === 'split';
              setSplit(split);
              onViewSettingsChange?.({ split });
            }}
          >
            <option value="split">Split</option>
            <option value="unified">Unified</option>
          </select>
          <label className="ep-toolbar-check">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(e) => {
                setWrap(e.target.checked);
                onViewSettingsChange?.({ wrap: e.target.checked });
              }}
            />{' '}
            Wrap lines
          </label>
          <IconButton
            icon={ChevronUp}
            label="Previous change"
            disabled={!hunks.length}
            onClick={() => jumpHunk(hunk - 1)}
          />
          <IconButton
            icon={ChevronDown}
            label="Next change"
            disabled={!hunks.length}
            onClick={() => jumpHunk(hunk + 1)}
          />
          <input
            className="ep-review-search"
            aria-label="Search diff"
            placeholder="Search diff"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatch(0);
            }}
          />
          <IconButton
            icon={Search}
            label="Next search match"
            disabled={!matches.length}
            onClick={() => {
              const next = (match + 1) % matches.length;
              setMatch(next);
              setTarget(matches[next]);
            }}
          />
          <span className="ep-muted">{matches.length ? `${match + 1}/${matches.length}` : ''}</span>
          <span className="ep-spacer" />
          <IconButton
            icon={Settings2}
            label="Comparison sources"
            disabled={readOnly}
            onClick={() =>
              setSources({
                id: file.id,
                name: file.name,
                oldText: file.oldText,
                newText: file.newText,
              })
            }
          />
        </>
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
          render={(row) =>
            row.line ? (
              <div className={split ? 'ep-diff-row split' : 'ep-diff-row'}>
                {split ? (
                  <>
                    {cell(row, 'old')}
                    {cell(row, 'new')}
                  </>
                ) : (
                  cell(row, row.line.type === 'removed' ? 'old' : 'new')
                )}
              </div>
            ) : (
              <button
                className="ep-diff-gap"
                onClick={() => setExpanded(new Set([...expanded, row.id]))}
              >
                Show {row.count} unchanged lines
              </button>
            )
          }
        />
        {!wrap && lineWidth > width / (split ? 2 : 1) - 78 && (
          <div
            ref={horizontal}
            className="ep-code-scroll"
            role="region"
            aria-label="Scroll code horizontally"
            tabIndex={0}
            onScroll={(e) =>
              body.current?.style.setProperty(
                '--ep-code-scroll',
                `${-e.currentTarget.scrollLeft}px`,
              )
            }
          >
            <div
              style={{
                width: width + Math.max(0, lineWidth - width / (split ? 2 : 1) + 78),
                height: 1,
              }}
            />
          </div>
        )}
        {!lines.length && <p className="ep-empty">Both files are empty.</p>}
      </div>
      {sources && (
        <Dialog title="Comparison sources" onClose={() => setSources(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (readOnly) return;
              if (content.files.some((f) => f.id === sources.id))
                execute(
                  replaceComparison(sources.id, sources.oldText, sources.newText, sources.name),
                );
              else {
                const added = {
                  ...sources,
                  oldRevision: newId('source'),
                  newRevision: newId('source'),
                };
                execute(
                  command('review.file.add', 'Add comparison file', (d) => ({
                    ...d,
                    schemaVersion: 2,
                    files: [...d.files, added],
                  })),
                );
              }
              setRange(undefined);
              setFileId(sources.id);
              setSources(undefined);
            }}
          >
            <label>
              File name
              <input
                aria-label="Comparison file name"
                value={sources.name}
                required
                onChange={(e) => setSources({ ...sources, name: e.target.value })}
              />
            </label>
            <div className="ep-source-pair">
              {(['oldText', 'newText'] as const).map((key) => (
                <label key={key}>
                  {key === 'oldText' ? 'Old text' : 'New text'}
                  <textarea
                    aria-label={key === 'oldText' ? 'Old text' : 'New text'}
                    rows={12}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    onPaste={(e) => {
                      e.preventDefault();
                      const input = e.currentTarget;
                      const text =
                        input.value.slice(0, input.selectionStart) +
                        e.clipboardData.getData('text/plain') +
                        input.value.slice(input.selectionEnd);
                      setSources({ ...sources, [key]: text });
                    }}
                    value={sources[key]}
                    onChange={(e) => setSources({ ...sources, [key]: e.target.value })}
                  />
                </label>
              ))}
            </div>
            <p>
              Replacing a side creates a new source revision. Its existing comments remain anchored
              to the previous revision and become outdated.
            </p>
            <button type="submit">Apply comparison sources</button>
          </form>
        </Dialog>
      )}
    </EditorLayout>
  );
}
