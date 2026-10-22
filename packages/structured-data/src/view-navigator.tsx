import { ArrowUp } from 'lucide-react';
import { clone, newId } from '@editor-platform/artifact-core';
import { type EditorCommand, type EditorInputs } from '@editor-platform/editor-core';
import { CommitInput, IconButton, Section } from '@editor-platform/editor-ui';
import { type StructuredData } from './model';
import { reorderColumn, saveView, type DataProjection } from './views';
import { type DataViewDraft } from './view-hooks';
import { projectionChoices, toggled } from './view-model';

type Apply = (cmd: EditorCommand<StructuredData>) => boolean;

function NamedViews({
  data,
  draft,
  readOnly,
  apply,
  inputs,
  onError,
  onField,
}: {
  data: StructuredData;
  draft: DataViewDraft;
  readOnly: boolean;
  apply: Apply;
  inputs: EditorInputs | undefined;
  onError: (error: string) => void;
  onField: (id: string) => void;
}) {
  const { view, patch, setView, acceptViewDraft } = draft;
  return (
    <Section title="Named views">
      {(data.views ?? []).map((v) => (
        <button
          className="ep-view-item"
          key={v.id}
          onClick={() => {
            try {
              inputs?.flush();
            } catch (error) {
              onError(String(error));
              return;
            }
            acceptViewDraft(v);
            setView(clone(v));
            onField('');
          }}
        >
          {v.name}
        </button>
      ))}
      <CommitInput label="View name" value={view.name} onCommit={(name) => patch({ name })} />
      <CommitInput
        label="View accent"
        type="color"
        value={view.accent ?? '#5269c8'}
        onCommit={(accent) => patch({ accent })}
      />
      <div className="ep-inline">
        <button
          disabled={readOnly || !view.name.trim()}
          onClick={() => {
            if (apply(saveView(view))) acceptViewDraft(view);
          }}
        >
          Save view
        </button>
        <button
          disabled={readOnly}
          onClick={() => {
            const next = { ...clone(view), id: newId('view'), name: `${view.name} copy` };
            if (apply(saveView(next))) {
              acceptViewDraft(next);
              setView(next);
            }
          }}
        >
          Save as
        </button>
      </div>
    </Section>
  );
}

function UnsavedViewChanges({ draft }: { draft: DataViewDraft }) {
  const { view, viewDirty, viewEdit, viewHistory, acceptViewDraft, setView } = draft;
  return (
    <Section title="Unsaved view changes">
      <p role="status">
        {viewDirty
          ? 'Dashboard構成が未保存です。保存/閉じる時は名前付きビューへ確定します。'
          : 'ビュー編集を取り消しました。'}
      </p>
      <button
        data-view-draft
        disabled={!viewEdit.current.past.length}
        onClick={() => viewHistory('undo')}
      >
        Undo view edit
      </button>
      <button disabled={!viewEdit.current.future.length} onClick={() => viewHistory('redo')}>
        Redo view edit
      </button>
      <button
        onClick={() => {
          const next = { ...view, widgets: clone(viewEdit.current.base.widgets) };
          acceptViewDraft(next);
          setView(next);
        }}
      >
        Discard view changes
      </button>
    </Section>
  );
}

function FieldList({
  data,
  draft,
  readOnly,
  apply,
  fieldId,
  onField,
}: {
  data: StructuredData;
  draft: DataViewDraft;
  readOnly: boolean;
  apply: Apply;
  fieldId: string;
  onField: (id: string) => void;
}) {
  const { view, patch } = draft;
  return (
    <Section title="Fields">
      {data.columns.map((c, i) => (
        <div className="ep-field-row" key={c.id}>
          <button className={fieldId === c.id ? 'active' : ''} onClick={() => onField(c.id)}>
            {c.name}
          </button>
          <button
            aria-label={`Hide ${c.name}`}
            aria-pressed={view.hidden.includes(c.id)}
            onClick={() =>
              patch({
                hidden: toggled(view.hidden, c.id, !view.hidden.includes(c.id)),
              })
            }
          >
            {view.hidden.includes(c.id) ? 'Show' : 'Hide'}
          </button>
          <IconButton
            icon={ArrowUp}
            label={`Move ${c.name} left`}
            disabled={readOnly || i === 0}
            onClick={() => apply(reorderColumn(c.id, data.columns[i - 1]?.id ?? null))}
          />
        </div>
      ))}
    </Section>
  );
}

export function DataNavigator({
  data,
  draft,
  readOnly,
  graph,
  apply,
  inputs,
  fieldId,
  onField,
  onError,
  changeProjection,
}: {
  data: StructuredData;
  draft: DataViewDraft;
  readOnly: boolean;
  graph: boolean;
  apply: Apply;
  inputs: EditorInputs | undefined;
  fieldId: string;
  onField: (id: string) => void;
  onError: (error: string) => void;
  changeProjection: (projection: DataProjection) => boolean;
}) {
  const { view, viewDirty, viewEdit } = draft;
  return (
    <>
      <Section title="Projections">
        {projectionChoices(graph).map((p) => (
          <button
            key={p}
            className={`ep-view-item ${view.projection === p ? 'active' : ''}`}
            onClick={() => changeProjection(p)}
          >
            {p}
          </button>
        ))}
      </Section>
      <NamedViews
        data={data}
        draft={draft}
        readOnly={readOnly}
        apply={apply}
        inputs={inputs}
        onError={onError}
        onField={onField}
      />
      {(viewDirty || viewEdit.current.past.length > 0 || viewEdit.current.future.length > 0) && (
        <UnsavedViewChanges draft={draft} />
      )}
      <FieldList
        data={data}
        draft={draft}
        readOnly={readOnly}
        apply={apply}
        fieldId={fieldId}
        onField={onField}
      />
    </>
  );
}
