import { useEffect, useState, memo, type ReactElement } from 'react';
import {
  type ReferenceSurfaceProps,
  ReferenceImage,
} from '@editor-platform/artifact-references/react';
import { IconButton, useWording, type Wording } from '@editor-platform/editor-ui';
import { type DocumentBlock, type DocumentContent } from './model';
import { MermaidPreview, HtmlPreview } from './previews';
import { outlineIndent, outlineLabel } from './view-model';

export function Embedded({
  block,
  references,
}: {
  block: DocumentBlock;
  references?: ReferenceSurfaceProps['references'];
}) {
  const t = useWording();
  return block.type === 'image' ? (
    <figure>
      <ReferenceImage item={block} resolver={references} width={block.width} />
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  ) : block.type === 'mermaid' ? (
    <MermaidPreview source={block.text} />
  ) : block.type === 'html' ? (
    <HtmlPreview source={block.text} />
  ) : (
    <div className="trusted-demo">
      <strong>{t('Trusted React adapter')}</strong>
      <p>{block.text}</p>
    </div>
  );
}

export function SourceInput({
  value,
  label,
  display,
  onCommit,
}: {
  value: string;
  label: string;
  /** Visible wording when it differs from the accessible name. */
  display?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="ep-field">
      {display ?? label}
      <textarea
        aria-label={label}
        value={draft}
        rows={9}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = value;
            setDraft(value);
            e.stopPropagation();
          }
        }}
      />
    </label>
  );
}

const DocumentOutlineRow = memo(function DocumentOutlineRow({
  id,
  label,
  indent,
  active,
  choose,
}: {
  id: string;
  label: string;
  indent: number;
  active: boolean;
  choose: (id: string) => void;
}) {
  return (
    <button
      className={`ep-outline-item ${active ? 'active' : ''}`}
      style={{ paddingLeft: indent }}
      onClick={() => choose(id)}
    >
      {label}
    </button>
  );
});

export function documentOutline(
  blocks: DocumentBlock[],
  selectedId: string | undefined,
  choose: (id: string) => void,
) {
  return (
    <>
      {blocks.map((b, i) => (
        <DocumentOutlineRow
          key={b.id}
          id={b.id}
          active={selectedId === b.id}
          indent={outlineIndent(b)}
          label={outlineLabel(b, i)}
          choose={choose}
        />
      ))}
    </>
  );
}

export type ToolButton = (
  label: string,
  icon: Parameters<typeof IconButton>[0]['icon'],
  action: () => void,
  pressed?: boolean,
) => ReactElement;

export function toolButtonFor(readOnly: boolean): ToolButton {
  return (label, icon, action, pressed) => (
    <IconButton
      key={label}
      label={label}
      icon={icon}
      disabled={readOnly}
      aria-pressed={pressed}
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
    />
  );
}

export function documentStatus(
  textMetrics: { words: number; characters: number; cjkCharacters?: number },
  content: DocumentContent,
  readOnly: boolean,
  t: Wording,
) {
  return (
    <>
      <span>
        {/* Mostly Japanese, Chinese or Korean text is measured in characters, not words. */}
        {(textMetrics.cjkCharacters ?? 0) * 2 > textMetrics.characters
          ? ''
          : `${t('{0} words', textMetrics.words)} · `}
        {t('{0} characters', textMetrics.characters)} · {t('{0} blocks', content.blocks.length)}
      </span>
      <span className="ep-spacer" />
      <span>{t(readOnly ? 'Read only' : 'Rich text · / to insert')}</span>
    </>
  );
}
