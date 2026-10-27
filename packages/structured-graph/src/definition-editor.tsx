import { useRef, useState } from 'react';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { useEditorInput } from '@editor-platform/editor-ui';
import { PropertyInput } from '@editor-platform/property-input';
import { type GraphDocument } from './model';
import {
  type GraphProfile,
  type GraphType,
  type AttributeSchema,
  type GraphEdgeType,
} from './profile';
import {
  previewGraphDefinition,
  type GraphDefinitionChange,
  type GraphDefinitionPreview,
  type GraphSourceActions,
} from './definition';
import { formatGraphDiagnostic } from './diagnostics';
export function GraphDefinitionEditor({
  graph,
  profile,
  scope,
  type,
  host,
  readOnly,
  onClose,
}: {
  graph: GraphDocument;
  profile: GraphProfile;
  scope: 'graph' | 'node' | 'edge' | 'section';
  type?: string;
  host?: GraphSourceActions;
  readOnly: boolean;
  onClose(): void;
}) {
  const definition =
    scope === 'graph'
      ? profile.graph
      : profile[scope === 'node' ? 'nodes' : scope === 'edge' ? 'edges' : 'sections'][type!];
  const [draft, setDraft] = useState<GraphType | GraphEdgeType>(() => clone(definition));
  const [field, setField] = useState(Object.keys(definition.schema)[0] ?? '');
  const [newField, setNewField] = useState('');
  const [error, setError] = useState('');
  const [schemaError, setSchemaError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const inputError = schemaError || connectionError || error;
  const [schemaText, setSchemaText] = useState(
    () => JSON.stringify(definition.schema[Object.keys(definition.schema)[0]], null, 2) ?? '{}',
  );
  const [connectionText, setConnectionText] = useState(() =>
    JSON.stringify((definition as GraphEdgeType).connection ?? {}, null, 2),
  );
  const root = useRef<HTMLFormElement>(null);
  const base = useRef(canonicalJson({ graph, profile }));
  const initial = useRef(canonicalJson(definition));
  const committed = useRef(false);
  const composing = useRef(false);
  const [isComposing, setComposing] = useState(false);
  const editable = !readOnly && !!host?.onEditDefinition && !host.readOnlyReason;
  const change: GraphDefinitionChange = { scope, ...(type ? { type } : {}), definition: draft };
  let preview: ReturnType<typeof previewGraphDefinition> | undefined;
  let previewError = '';
  try {
    preview = previewGraphDefinition({ graph, profile }, change);
  } catch (error) {
    previewError = String(error instanceof Error ? error.message : error);
  }
  const dirty = !committed.current && (canonicalJson(draft) !== initial.current || !!inputError);
  const stale = canonicalJson({ graph, profile }) !== base.current;
  function prepare() {
    if (!editable) throw new Error(host?.readOnlyReason ?? 'この定義は所有元で編集してください。');
    if (stale)
      throw new Error(
        '元データまたは定義が変更されました。入力をコピーして定義を開き直してください。',
      );
    if (
      inputError ||
      previewError ||
      !preview ||
      preview.diagnostics.some((diagnostic) => diagnostic.blocking)
    )
      throw new Error(
        inputError || previewError || '移行プレビューの無効な値・関係を修正してください。',
      );
    const request = { base: base.current, change, preview };
    return () => {
      if (host!.onEditDefinition!(request) === false) return false;
      committed.current = true;
      onClose();
    };
  }
  useEditorInput({
    label: 'Graphデータ定義',
    read: () => ({ dirty, composing: composing.current }),
    prepare,
    focus: () => root.current?.querySelector<HTMLElement>('input,select,textarea')?.focus(),
  });
  function patchField(value: Partial<AttributeSchema>) {
    const next = { ...draft.schema[field], ...value };
    setDraft({ ...draft, schema: { ...draft.schema, [field]: next } });
    setSchemaText(JSON.stringify(next, null, 2));
    setSchemaError('');
    setError('');
  }
  return (
    <form
      ref={root}
      aria-label="Graph data definition"
      className="ep-graph-definition"
      onCompositionStart={() => {
        composing.current = true;
        setComposing(true);
      }}
      onCompositionEnd={() => {
        composing.current = false;
        setComposing(false);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (isComposing) return;
        try {
          prepare()();
        } catch (error) {
          setError(String(error instanceof Error ? error.message : error));
        }
      }}
    >
      <h3>
        データ定義 · {scope} {type ?? profile.id}
      </h3>
      <p>
        所有元: {host?.owner ?? `Host Profile ${profile.id}`} · v{profile.version}
      </p>
      {!editable && (
        <p role="status">
          {host?.readOnlyReason ??
            'HostがこのProfileの編集を許可していません。所有元へ変更を依頼してください。'}
        </p>
      )}
      <p>この画面は項目・型・関係の定義です。ノードの値は属性画面で編集します。</p>
      <fieldset disabled={!editable}>
        <label>
          型の表示名
          <input
            aria-label="Definition type label"
            value={draft.ui?.label ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, ui: { ...draft.ui, label: event.target.value } })
            }
          />
        </label>
        <label>
          属性
          <select
            aria-label="Definition field"
            value={field}
            onChange={(event) => {
              if (schemaError) return;
              setField(event.target.value);
              setSchemaText(JSON.stringify(draft.schema[event.target.value], null, 2));
            }}
          >
            {Object.keys(draft.schema).map((key) => (
              <option key={key} value={key}>
                {draft.ui?.fields?.[key]?.label ?? key}
              </option>
            ))}
          </select>
        </label>
        {draft.schema[field] && (
          <DefinitionFieldSettings
            draft={draft}
            field={field}
            setDraft={setDraft}
            schemaText={schemaText}
            setSchemaText={setSchemaText}
            setSchemaError={setSchemaError}
            setError={setError}
            patchField={patchField}
          />
        )}
        <label>
          追加属性ID
          <input
            aria-label="New definition field ID"
            value={newField}
            onChange={(event) => setNewField(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!!schemaError || !newField.trim() || Object.hasOwn(draft.schema, newField)}
          onClick={() => {
            setDraft({ ...draft, schema: { ...draft.schema, [newField]: { type: 'string' } } });
            setField(newField);
            setSchemaText(JSON.stringify({ type: 'string' }, null, 2));
            setNewField('');
          }}
        >
          属性を追加
        </button>
        {scope === 'edge' && (
          <PropertyInput
            label="Connection constraints"
            showLabel
            type="json"
            value={connectionText}
            onChange={(value) => {
              setConnectionText(value);
              try {
                setDraft({ ...draft, connection: JSON.parse(value) });
                setConnectionError('');
                setError('');
              } catch {
                setConnectionError('有効なJSONで接続制約を入力してください。');
              }
            }}
          />
        )}
      </fieldset>
      {!editable && (
        <details>
          <summary>型・属性・関係制約の詳細</summary>
          <pre>{JSON.stringify(profile, null, 2)}</pre>
        </details>
      )}
      <DefinitionPreviewFooter
        preview={preview}
        inputError={inputError}
        previewError={previewError}
        stale={stale}
        editable={editable}
        dirty={dirty}
        onClose={onClose}
      />
    </form>
  );
}

type DefinitionDraft = GraphType | GraphEdgeType;
function defaultFieldSchema(
  type: AttributeSchema['type'],
  required: boolean | undefined,
): AttributeSchema {
  return {
    type,
    required,
    ...(type === 'enum'
      ? { enum: ['value'] }
      : type === 'array'
        ? { items: { type: 'string' } }
        : type === 'object'
          ? { properties: {} }
          : {}),
  };
}
function DefinitionFieldSettings({
  draft,
  field,
  setDraft,
  schemaText,
  setSchemaText,
  setSchemaError,
  setError,
  patchField,
}: {
  draft: DefinitionDraft;
  field: string;
  setDraft: (draft: DefinitionDraft) => void;
  schemaText: string;
  setSchemaText: (text: string) => void;
  setSchemaError: (message: string) => void;
  setError: (message: string) => void;
  patchField: (value: Partial<AttributeSchema>) => void;
}) {
  return (
    <>
      <label>
        項目の表示名
        <input
          aria-label="Definition field label"
          value={draft.ui?.fields?.[field]?.label ?? field}
          onChange={(event) =>
            setDraft({
              ...draft,
              ui: {
                ...draft.ui,
                fields: {
                  ...draft.ui?.fields,
                  [field]: { ...draft.ui?.fields?.[field], label: event.target.value },
                },
              },
            })
          }
        />
      </label>
      <label>
        値の型
        <select
          aria-label="Definition field type"
          value={draft.schema[field].type}
          onChange={(event) => {
            const next = defaultFieldSchema(
              event.target.value as AttributeSchema['type'],
              draft.schema[field].required,
            );
            setDraft({ ...draft, schema: { ...draft.schema, [field]: next } });
            setSchemaText(JSON.stringify(next, null, 2));
            setSchemaError('');
            setError('');
          }}
        >
          {['string', 'number', 'boolean', 'enum', 'array', 'object'].map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          aria-label="Definition required"
          checked={!!draft.schema[field].required}
          onChange={(event) => patchField({ required: event.target.checked })}
        />
        必須
      </label>
      <PropertyInput
        label="Definition field schema"
        showLabel
        type="json"
        value={schemaText}
        onChange={(value) => {
          setSchemaText(value);
          try {
            setDraft({ ...draft, schema: { ...draft.schema, [field]: JSON.parse(value) } });
            setSchemaError('');
            setError('');
          } catch {
            setSchemaError('有効なJSONで属性の制約を入力してください。');
          }
        }}
      />
    </>
  );
}
function DefinitionPreviewFooter({
  preview,
  inputError,
  previewError,
  stale,
  editable,
  dirty,
  onClose,
}: {
  preview?: GraphDefinitionPreview;
  inputError: string;
  previewError: string;
  stale: boolean;
  editable: boolean;
  dirty: boolean;
  onClose(): void;
}) {
  return (
    <>
      {preview && (
        <p role="status">
          移行プレビュー: {preview.changedIds.length}対象 · {preview.convertedValues}値を変換 ·{' '}
          {preview.diagnostics.length}件の問題
        </p>
      )}
      {preview?.diagnostics.map((diagnostic, i) => (
        <p role="alert" key={i}>
          {formatGraphDiagnostic(diagnostic, preview.graph, preview.profile, 'ja')}
        </p>
      ))}
      {(inputError || previewError || stale) && (
        <p role="alert">
          {inputError || previewError || '元データが変更されています。定義を開き直してください。'}
        </p>
      )}
      <button
        type="submit"
        disabled={
          !editable ||
          !dirty ||
          !!inputError ||
          !!previewError ||
          !!preview?.diagnostics.some((diagnostic) => diagnostic.blocking) ||
          stale
        }
      >
        定義と値の移行を保存
      </button>
      <button type="button" onClick={onClose}>
        定義編集をキャンセル
      </button>
    </>
  );
}
