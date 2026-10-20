import { type EditorState } from 'prosemirror-state';
import { ArrowUp, ArrowDown, Trash2, AlignLeft, AlignCenter, AlignRight } from 'lucide-react';
import {
  ReferenceInspector,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import { Section, CommitInput } from '@editor-platform/editor-ui';
import { type DocumentBlock, type DocumentContent } from './model';
import { type DocumentActions } from './view-actions';
import { blockLabels, documentTableActions } from './view-model';
import { SourceInput, type ToolButton } from './view-parts';

const sourceTypes = ['mermaid', 'html', 'react-preview'];

function BlockFields({
  selected,
  actions,
  toolButton,
}: {
  selected: DocumentBlock;
  actions: DocumentActions;
  toolButton: ToolButton;
}) {
  const { patchBlock, mark } = actions;
  return selected.type === 'image' ? (
    <>
      <CommitInput
        label="Alt text"
        value={selected.alt ?? ''}
        onCommit={(alt) => patchBlock({ alt })}
      />
      <CommitInput
        label="Image width"
        value={selected.width ?? 600}
        type="number"
        min={40}
        max={1200}
        onCommit={(v) => patchBlock({ width: Number(v) })}
      />
      <CommitInput
        label="Caption"
        value={selected.caption ?? ''}
        onCommit={(caption) => patchBlock({ caption })}
      />
    </>
  ) : sourceTypes.includes(selected.type) ? (
    <SourceInput
      label={`${blockLabels[selected.type]} source`}
      value={selected.text}
      onCommit={(text) => patchBlock({ text })}
    />
  ) : selected.type === 'code' ? (
    <CommitInput
      label="Code language"
      value={selected.language ?? 'text'}
      onCommit={(language) => patchBlock({ language })}
    />
  ) : (
    <>
      <div className="ep-inline">
        {toolButton('Align left', AlignLeft, () => patchBlock({ align: 'left' }))}
        {toolButton('Align center', AlignCenter, () => patchBlock({ align: 'center' }))}
        {toolButton('Align right', AlignRight, () => patchBlock({ align: 'right' }))}
      </div>
      <label className="ep-field">
        Text color
        <input
          aria-label="Document text color"
          type="color"
          defaultValue="#253044"
          onChange={(e) => mark('color', { value: e.target.value })}
        />
      </label>
    </>
  );
}

function BlockSection({
  selected,
  references,
  readOnly,
  actions,
  toolButton,
}: {
  selected?: DocumentBlock;
  references?: ReferenceSurfaceProps['references'];
  readOnly: boolean;
  actions: DocumentActions;
  toolButton: ToolButton;
}) {
  return (
    <Section title="Block">
      {selected ? (
        <>
          <p>{blockLabels[selected.type]}</p>
          <div className="ep-inline">
            {toolButton('Move block up', ArrowUp, () => actions.move(-1))}
            {toolButton('Move block down', ArrowDown, () => actions.move(1))}
            {toolButton('Delete block', Trash2, actions.remove)}
          </div>
          <ReferenceInspector
            item={selected}
            fitSupported={false}
            resolver={references}
            readOnly={readOnly}
            patch={(patch) => actions.patchBlock(patch)}
          />
          <fieldset disabled={readOnly}>
            <BlockFields selected={selected} actions={actions} toolButton={toolButton} />
          </fieldset>
        </>
      ) : (
        <p>Select a block.</p>
      )}
    </Section>
  );
}

function TableSection({
  readOnly,
  engineState,
  run,
}: {
  readOnly: boolean;
  engineState: EditorState | null;
  run: DocumentActions['run'];
}) {
  return (
    <Section title="Table">
      <div className="ep-action-grid">
        {documentTableActions.map(([label, cmd]) => (
          <button
            key={label}
            disabled={readOnly || !engineState || !cmd(engineState)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(cmd)}
          >
            {label}
          </button>
        ))}
      </div>
    </Section>
  );
}

function PageSection({
  content,
  readOnly,
  pageSetting,
}: {
  content: DocumentContent;
  readOnly: boolean;
  pageSetting: DocumentActions['pageSetting'];
}) {
  return (
    <Section title="Page">
      <fieldset disabled={readOnly}>
        <label className="ep-field">
          Paper size
          <select
            aria-label="Paper size"
            value={content.page?.size ?? 'A4'}
            onChange={(e) => pageSetting({ size: e.target.value as 'A4' | 'Letter' })}
          >
            <option>A4</option>
            <option>Letter</option>
          </select>
        </label>
        <CommitInput
          label="Page margin"
          value={content.page?.margin ?? 64}
          type="number"
          min={24}
          max={160}
          onCommit={(v) => pageSetting({ margin: Number(v) })}
        />
      </fieldset>
    </Section>
  );
}

export function DocumentInspector({
  selected,
  references,
  readOnly,
  engineState,
  content,
  actions,
  toolButton,
}: {
  selected?: DocumentBlock;
  references?: ReferenceSurfaceProps['references'];
  readOnly: boolean;
  engineState: EditorState | null;
  content: DocumentContent;
  actions: DocumentActions;
  toolButton: ToolButton;
}) {
  return (
    <>
      <BlockSection
        selected={selected}
        references={references}
        readOnly={readOnly}
        actions={actions}
        toolButton={toolButton}
      />
      <TableSection readOnly={readOnly} engineState={engineState} run={actions.run} />
      <PageSection content={content} readOnly={readOnly} pageSetting={actions.pageSetting} />
    </>
  );
}
