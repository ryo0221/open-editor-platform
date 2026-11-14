import { Fragment, useMemo, useState, type ReactNode } from 'react';
import type { Annotation, EditorCommand } from '@editor-platform/editor-core';
import { Section } from '@editor-platform/editor-ui';
import {
  ReferenceImage,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import {
  checkDocumentNotation,
  checkDocumentRuby,
  documentCharacterCount,
  manuscriptPaperEstimate,
  notationEditCommand,
  type DocumentCharacterCountOptions,
  type ManuscriptPaperOptions,
  type NotationFinding,
  type NotationRule,
} from './manuscript';
import {
  isVerticalDocument,
  nestedLists,
  resolveDocumentAddress,
  rubyGroups,
  type DocumentBlock,
  type DocumentContent,
  type InlineSpan,
} from './model';

export type DocumentWorkspace = 'document' | 'novel';

/** Host-owned inputs of the novel workspace. Documents store none of them. */
export interface DocumentNovelOptions {
  /** Optional Host-owned character/location references; never stored in Document content. */
  references?: ReactNode;
  characterCount?: DocumentCharacterCountOptions;
  paper?: ManuscriptPaperOptions;
  /** The Host's notation dictionary. Without it no check is shown. */
  notationRules?: readonly NotationRule[];
  /** Receives the author's chosen corrections as one native command. The Host proposes it
   * through `ArtifactEditor.propose`; the Surface never applies it. Omitted: no propose button. */
  onNotationProposal?(request: {
    command: EditorCommand<DocumentContent>;
    findings: NotationFinding[];
  }): void;
  /** Read-through of saved chapters, e.g. `composeDocumentSequence` over committed versions.
   * The Surface only shows it; drafts are never mixed in. Omitted: 通読 is unavailable. */
  reading?: { content: DocumentContent; label?: string };
  /** Why the Host could not compose a read-through, shown next to the disabled 通読. */
  readingUnavailable?: string;
  /** The Host's character goal for this chapter, counted with `characterCount`. The Host stores
   * it; with `onGoalChange` the author can set or clear it here. */
  goal?: number;
  onGoalChange?(goal: number | undefined): void;
}
/** The largest character goal the panel accepts (a long novel is about 1,000,000). */
export const novelGoalLimit = 10_000_000;

const headingText = (block: DocumentBlock) =>
  (block.rich?.map((span) => span.text).join('') ?? block.text) || '無題';

/** Left pane: headings of this chapter as its scene list, with their character counts. */
export function NovelSceneList({
  content,
  options,
  selectedId,
  choose,
}: {
  content: DocumentContent;
  options?: DocumentNovelOptions;
  selectedId?: string;
  choose(id: string): void;
}) {
  const scenes = useMemo(() => {
    const count = documentCharacterCount(content, options?.characterCount);
    const byBlock = new Map<string, number>();
    for (const segment of count.segments)
      byBlock.set(segment.blockId, (byBlock.get(segment.blockId) ?? 0) + segment.count);
    const found: { id: string; label: string; level: number; count: number }[] = [];
    for (const block of content.blocks) {
      if (block.hidden && !count.rule.hidden) continue;
      if (block.type === 'heading')
        found.push({ id: block.id, label: headingText(block), level: block.level ?? 1, count: 0 });
      else if (found.length) found[found.length - 1].count += byBlock.get(block.id) ?? 0;
    }
    return found;
  }, [content, options?.characterCount]);
  if (!scenes.length)
    return <p className="ep-novel-empty">見出しを付けると章・シーンとして並びます。</p>;
  return (
    <nav aria-label="章・シーン">
      {scenes.map((scene) => (
        <button
          key={scene.id}
          className={`ep-outline-item ep-novel-scene ${selectedId === scene.id ? 'active' : ''}`}
          style={{ paddingLeft: 9 + (scene.level - 1) * 14 }}
          onClick={() => choose(scene.id)}
        >
          <span>{scene.label}</span>
          <small className="ep-novel-count">{scene.count.toLocaleString('ja-JP')}字</small>
        </button>
      ))}
    </nav>
  );
}

/** Right pane: counts, manuscript-paper estimate and dictionary findings. Read-only by itself. */
export function NovelManuscriptPanel({
  content,
  options,
  readOnly,
  choose,
  annotations = [],
}: {
  content: DocumentContent;
  options?: DocumentNovelOptions;
  readOnly: boolean;
  choose(id: string): void;
  /** The Host's range annotations (reader remarks). Shown and followed; never edited here. */
  annotations?: readonly Annotation[];
}) {
  const summary = useMemo(() => {
    try {
      return {
        count: documentCharacterCount(content, options?.characterCount),
        paper: manuscriptPaperEstimate(content, options?.paper),
        findings: options?.notationRules
          ? checkDocumentNotation(content, options.notationRules)
          : undefined,
        rubies: checkDocumentRuby(content),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [content, options?.characterCount, options?.paper, options?.notationRules]);
  // A choice belongs to the findings it was made on; any content or dictionary change clears it.
  const [choice, setChoice] = useState<{ basis: object; keys: ReadonlySet<string> }>();
  const chosen = choice?.basis === summary ? choice.keys : new Set<string>();
  const setChosen = (keys: ReadonlySet<string>) => setChoice({ basis: summary, keys });
  const [error, setError] = useState('');
  if ('error' in summary)
    return (
      <p role="alert" className="ep-error">
        {summary.error}
      </p>
    );
  const { count, paper, findings, rubies } = summary;
  const keyOf = (finding: NotationFinding) =>
    `${finding.edit.segmentId}:${finding.edit.start}:${finding.edit.end}`;
  const selected = findings?.filter((finding) => chosen.has(keyOf(finding))) ?? [];
  const propose = () => {
    setError('');
    try {
      options?.onNotationProposal?.({
        command: notationEditCommand(content, selected),
        findings: selected,
      });
      setChosen(new Set());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <div className="ep-novel-panel">
      <Section title="原稿">
        <dl className="ep-novel-stats">
          <dt>文字数</dt>
          <dd aria-label="文字数">{count.total.toLocaleString('ja-JP')}字</dd>
          <dt>原稿用紙</dt>
          <dd aria-label="原稿用紙換算">
            約{paper.sheets.toLocaleString('ja-JP')}枚（{paper.columns}×{paper.rows}・
            {paper.lines.toLocaleString('ja-JP')}行）
          </dd>
          {(options?.goal !== undefined || options?.onGoalChange) && (
            <NovelGoal
              total={count.total}
              goal={options.goal}
              onChange={readOnly ? undefined : options.onGoalChange}
            />
          )}
        </dl>
        <p className="ep-novel-note">
          {count.rule.whitespace ? '空白を含む' : '空白を除く'}・
          {count.rule.lineBreaks ? '改行を含む' : '改行を除く'}・
          {count.rule.hidden ? '非表示を含む' : '非表示を除く'}
          。原稿用紙は
          {paper.lineBreaking === 'kinsoku' ? '禁則・ぶら下げを考えた' : '禁則を考えない'}
          近似です。
        </p>
      </Section>
      <NovelAnnotations content={content} annotations={annotations} choose={choose} />
      {rubies.length > 0 && (
        <Section title={`ルビの確認（${rubies.length}件）`}>
          <ul className="ep-novel-findings">
            {rubies.map((ruby) => (
              <li key={`${ruby.segmentId}:${ruby.start}`}>
                <button type="button" onClick={() => choose(ruby.blockId)}>
                  「{ruby.found}」のルビ「{ruby.ruby.text}」は「{ruby.ruby.base}」に付けた読みです
                </button>
              </li>
            ))}
          </ul>
          <p className="ep-novel-note">文字を選んでルビを付け直すか、外してください。</p>
        </Section>
      )}
      {findings && (
        <Section title={`表記の照合（${findings.length}件）`}>
          {findings.length === 0 ? (
            <p className="ep-novel-note">辞書と違う表記はありません。</p>
          ) : (
            <ul className="ep-novel-findings">
              {findings.map((finding) => {
                const key = keyOf(finding);
                return (
                  <li key={key}>
                    {options?.onNotationProposal && (
                      <input
                        type="checkbox"
                        aria-label={`「${finding.found}」を「${finding.preferred}」に直す`}
                        checked={chosen.has(key)}
                        disabled={readOnly}
                        onChange={(event) => {
                          const next = new Set(chosen);
                          if (event.currentTarget.checked) next.add(key);
                          else next.delete(key);
                          setChosen(next);
                        }}
                      />
                    )}
                    <button type="button" onClick={() => choose(finding.blockId)}>
                      「{finding.found}」→「{finding.preferred}」
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {options?.onNotationProposal && findings.length > 0 && (
            <button type="button" disabled={readOnly || !selected.length} onClick={propose}>
              選んだ直しを提案
            </button>
          )}
          {error && (
            <p role="alert" className="ep-error">
              {error}
            </p>
          )}
          <p className="ep-novel-note">本文は提案を採用するまで変わりません。</p>
        </Section>
      )}
    </div>
  );
}

/** Goal and progress. A goal is a whole number of characters, 1 to `novelGoalLimit`. */
function NovelGoal({
  total,
  goal,
  onChange,
}: {
  total: number;
  goal?: number;
  onChange?(goal: number | undefined): void;
}) {
  const valid = goal !== undefined && Number.isSafeInteger(goal) && goal > 0;
  const [text, setText] = useState<string>();
  const shown = text ?? (valid ? String(goal) : '');
  const commit = () => {
    if (text === undefined) return;
    setText(undefined);
    const trimmed = text.trim();
    if (!trimmed) return onChange?.(undefined);
    const value = Number(trimmed);
    if (Number.isSafeInteger(value) && value > 0 && value <= novelGoalLimit) onChange?.(value);
  };
  return (
    <>
      <dt>目標</dt>
      <dd>
        {onChange ? (
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={novelGoalLimit}
            step={1}
            aria-label="文字数の目標"
            placeholder="なし"
            value={shown}
            onChange={(event) => setText(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit();
              if (event.key === 'Escape') setText(undefined);
            }}
          />
        ) : valid ? (
          `${goal.toLocaleString('ja-JP')}字`
        ) : (
          'なし'
        )}
        {valid && (
          <span aria-label="目標までの進み具合" className="ep-novel-goal">
            {total >= goal
              ? `達成（${Math.floor((total / goal) * 100)}%）`
              : `${Math.floor((total / goal) * 100)}%・残り${(goal - total).toLocaleString('ja-JP')}字`}
          </span>
        )}
      </dd>
    </>
  );
}

/** Range annotations on this chapter: open first, each followed to its block. */
function NovelAnnotations({
  content,
  annotations,
  choose,
}: {
  content: DocumentContent;
  annotations: readonly Annotation[];
  choose(id: string): void;
}) {
  if (!annotations.length) return null;
  const blocks = new Map(content.blocks.map((block) => [block.id, block]));
  const open = annotations.filter((a) => !a.resolved).length;
  const ordered = [...annotations].sort((a, b) => Number(a.resolved) - Number(b.resolved));
  return (
    <Section title={`範囲の指摘（未解決${open}件）`}>
      <ul className="ep-novel-findings" aria-label="範囲の指摘">
        {ordered.map((annotation) => {
          // As the editor's highlights do, follow the range only while it still resolves.
          const found = annotation.anchor.addresses
            .map((address) => ({
              state: resolveDocumentAddress(content, address).state,
              block: blocks.get(address.elementId),
            }))
            .find((r) => r.block && r.state !== 'Orphan');
          const target = found?.block;
          const changed = found?.state === 'Outdated' ? '（範囲の文が変わりました）' : '';
          const first = annotation.comments[0];
          const label = `${first?.body ?? ''}${annotation.comments.length > 1 ? `（ほか${annotation.comments.length - 1}件）` : ''}`;
          const where = target ? headingText(target).slice(0, 24) : undefined;
          return (
            <li key={annotation.id} data-resolved={annotation.resolved || undefined}>
              {target ? (
                <button type="button" onClick={() => choose(target.id)}>
                  {annotation.resolved ? '解決済み・' : ''}「{where}」{changed}：{label}
                </button>
              ) : (
                <span>
                  {annotation.resolved ? '解決済み・' : ''}
                  元の範囲がこの章にありません（削除されたか、別の章です）：{label}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="ep-novel-note">指摘は本文を変えません。付け方と解決はHostの注釈で行います。</p>
    </Section>
  );
}

const readable = new Set(['heading', 'paragraph', 'bulleted-list', 'numbered-list', 'check-list']);
function lines(text: string) {
  return text.split('\n').flatMap((line, i) => (i ? [<br key={i} />, line] : [line]));
}
function listTexts(items: NonNullable<DocumentBlock['items']>): InlineSpan[][] {
  return items.flatMap((item) => [
    item.rich,
    ...nestedLists(item).flatMap((list) => listTexts(list.items)),
  ]);
}
/** Text with rubies and 傍点; other formatting is not part of the read-through. */
function spans(rich: InlineSpan[]) {
  return rubyGroups(rich).map(({ spans, ruby }, i) => {
    const text = spans.map((span, k) =>
      span.emphasisDots ? (
        <span key={k} className="ep-emphasis">
          {lines(span.text)}
        </span>
      ) : (
        <Fragment key={k}>{lines(span.text)}</Fragment>
      ),
    );
    return ruby ? (
      <ruby key={i}>
        {text}
        <rt>{ruby.text}</rt>
      </ruby>
    ) : (
      <span key={i}>{text}</span>
    );
  });
}

/** Read-only Host-composed saved chapters; references retain the normal live access guard. */
export function NovelReading({
  reading,
  references,
}: {
  reading: NonNullable<DocumentNovelOptions['reading']>;
  references?: ReferenceSurfaceProps['references'];
}) {
  const blocks = reading.content.blocks.filter((block) => !block.hidden);
  return (
    <article
      className="ep-novel-reading"
      aria-label="通読"
      data-writing-mode={isVerticalDocument(reading.content) ? 'vertical-rl' : undefined}
    >
      <p className="ep-novel-note">
        {reading.label ?? '保存した版を結合した通読です。'}編集中の内容は含みません。
      </p>
      {blocks.map((block) => {
        if (block.type === 'image')
          return (
            <figure key={block.id} className="ep-novel-reading-image">
              {block.reference && !references ? (
                <p role="status">画像参照のHostが接続されていません。</p>
              ) : (
                <ReferenceImage item={block} resolver={references} width={block.width} />
              )}
              {block.caption && <figcaption>{block.caption}</figcaption>}
            </figure>
          );
        if (!readable.has(block.type))
          return (
            <p key={block.id} className="ep-novel-note">
              （通読では表示しない要素）
            </p>
          );
        if (block.items)
          return (
            <ul key={block.id}>
              {listTexts(block.items).map((rich, i) => (
                <li key={i}>{spans(rich)}</li>
              ))}
            </ul>
          );
        const text = spans(block.rich ?? [{ text: block.text }]);
        if (block.type === 'heading') {
          const Tag = `h${Math.min(Math.max(block.level ?? 1, 1), 6)}` as 'h1';
          return <Tag key={block.id}>{text}</Tag>;
        }
        return <p key={block.id}>{text}</p>;
      })}
    </article>
  );
}
