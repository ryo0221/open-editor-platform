import type { RefObject } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import type { DiffLine } from './model';
import {
  inRange,
  pastedText,
  sideLine,
  tokenClass,
  type ReviewRange,
  type ReviewRow,
  type ReviewSide,
  type ReviewSources,
} from './review-utils';

export function Highlight({ text }: { text: string }) {
  return (
    <>
      {text
        .split(
          /(\b(?:export|function|return|const|let|import|from|if|string|number|class|async|await)\b|"[^"]*"|'[^']*'|`[^`]*`)/g,
        )
        .map((t, i) => (
          <span key={i} className={tokenClass(t)}>
            {t}
          </span>
        ))}
    </>
  );
}

function lineSign(type: DiffLine['type']) {
  if (type === 'added') return '+';
  return type === 'removed' ? '−' : ' ';
}

function DiffCell({
  row,
  side,
  range,
  onChoose,
}: {
  row: ReviewRow;
  side: ReviewSide;
  range: ReviewRange | undefined;
  onChoose(index: number, side: ReviewSide, shift: boolean): void;
}) {
  const line = row.line!,
    n = sideLine(line, side);
  if (!n) return <div className="ep-diff-cell ep-diff-empty" />;
  return (
    <button
      className={`ep-diff-cell ${line.type} ${inRange(range, side, n) ? 'selected' : ''}`}
      aria-label={`${line.type} ${side} line ${n}`}
      onClick={(e) => onChoose(row.index, side, e.shiftKey)}
    >
      <span className="ep-line-number">{n}</span>
      <span className="ep-line-sign">{lineSign(line.type)}</span>
      <code>
        <span className="ep-code-text">
          <Highlight text={line.text || ' '} />
        </span>
      </code>
    </button>
  );
}

export function DiffRowView({
  row,
  split,
  range,
  onChoose,
  onExpand,
}: {
  row: ReviewRow;
  split: boolean;
  range: ReviewRange | undefined;
  onChoose(index: number, side: ReviewSide, shift: boolean): void;
  onExpand(id: string): void;
}) {
  if (!row.line)
    return (
      <button className="ep-diff-gap" onClick={() => onExpand(row.id)}>
        Show {row.count} unchanged lines
      </button>
    );
  return (
    <div className={split ? 'ep-diff-row split' : 'ep-diff-row'}>
      {split ? (
        <>
          <DiffCell row={row} side="old" range={range} onChoose={onChoose} />
          <DiffCell row={row} side="new" range={range} onChoose={onChoose} />
        </>
      ) : (
        <DiffCell
          row={row}
          side={row.line.type === 'removed' ? 'old' : 'new'}
          range={range}
          onChoose={onChoose}
        />
      )}
    </div>
  );
}

export function CodeScrollbar({
  scrollRef,
  bodyRef,
  width,
  overflow,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  width: number;
  overflow: number;
}) {
  return (
    <div
      ref={scrollRef}
      className="ep-code-scroll"
      role="region"
      aria-label="Scroll code horizontally"
      tabIndex={0}
      onScroll={(e) =>
        bodyRef.current?.style.setProperty('--ep-code-scroll', `${-e.currentTarget.scrollLeft}px`)
      }
    >
      <div style={{ width: width + Math.max(0, overflow), height: 1 }} />
    </div>
  );
}

export function ComparisonSourcesDialog({
  sources,
  onChange,
  onApply,
  onClose,
}: {
  sources: ReviewSources;
  onChange(sources: ReviewSources): void;
  onApply(): void;
  onClose(): void;
}) {
  return (
    <Dialog title="Comparison sources" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onApply();
        }}
      >
        <label>
          File name
          <input
            aria-label="Comparison file name"
            value={sources.name}
            required
            onChange={(e) => onChange({ ...sources, name: e.target.value })}
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
                  const text = pastedText(e.currentTarget, e.clipboardData.getData('text/plain'));
                  onChange({ ...sources, [key]: text });
                }}
                value={sources[key]}
                onChange={(e) => onChange({ ...sources, [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <p>
          Replacing a side creates a new source revision. Its existing comments remain anchored to
          the previous revision and become outdated.
        </p>
        <button type="submit">Apply comparison sources</button>
      </form>
    </Dialog>
  );
}
