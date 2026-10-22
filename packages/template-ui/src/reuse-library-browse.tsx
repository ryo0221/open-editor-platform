import { refKey, type ReuseInstance } from '@editor-platform/reuse-core';
import {
  retainedComponent,
  type CatalogAdapter,
  type ComponentDefinition,
  type NativeContent,
  type ReusableDraft,
} from '@editor-platform/templates';
import { draftDefinition } from './reuse-revision';
import { artifactModeOptions } from './reuse-library-model';

export function ArtifactModeFieldset(props: {
  content: NativeContent;
  instances: ReuseInstance[];
  disabled: boolean;
  value: string;
  onChange(value: string): void;
  onPreview(): void;
}) {
  return (
    <fieldset disabled={props.disabled}>
      <legend>成果物のトークンモード</legend>
      <label>
        成果物で継承するモード
        <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
          <option value="">各トークンの既定値</option>
          {artifactModeOptions(props.content, props.instances).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <button onClick={props.onPreview}>成果物のモードをプレビュー</button>
    </fieldset>
  );
}

export function LinkedInstanceList(props: {
  content: NativeContent;
  instances: ReuseInstance[];
  onSelect(retained: ReturnType<typeof retainedComponent>): void;
}) {
  const { content, instances } = props;
  return (
    <>
      <h3>この成果物のリンク部品</h3>
      {instances.length === 0 && <p>リンク部品はありません。</p>}
      {instances.map((i) => (
        <button key={i.id} onClick={() => props.onSelect(retainedComponent(content, i.id))}>
          {retainedComponent(content, i.id).definition.name} v{i.ref.version}
        </button>
      ))}
    </>
  );
}

export function ComponentBrowser(props: {
  items: ComponentDefinition[];
  archived: string[];
  drafts: ReusableDraft[];
  search: string;
  includeArchived: boolean;
  busy: boolean;
  readOnly: boolean;
  writeCatalog?: CatalogAdapter;
  onSearch(value: string): void;
  onIncludeArchived(value: boolean): void;
  onSelect(definition: ComponentDefinition): void;
  onDraft(draft: ReusableDraft): void;
  onImport(file: File): void;
}) {
  const { items, archived, drafts } = props;
  return (
    <>
      <label>
        部品を検索
        <input value={props.search} onChange={(e) => props.onSearch(e.target.value)} />
      </label>
      <label>
        <input
          type="checkbox"
          checked={props.includeArchived}
          onChange={(e) => props.onIncludeArchived(e.target.checked)}
        />
        アーカイブ済みも表示
      </label>
      {items
        .filter((d) => d.name.includes(props.search))
        .map((d) => (
          <button key={refKey(d)} onClick={() => props.onSelect(d)}>
            {d.name} v{d.version}
            {archived.includes(refKey(d)) ? '（アーカイブ済み）' : ''}
          </button>
        ))}
      {items.length === 0 && <p>「再利用部品として保存」から部品を作成できます。</p>}
      {drafts.length > 0 && <h3>保存した下書き</h3>}
      {drafts.map((draft) => (
        <button key={draft.id} disabled={props.readOnly} onClick={() => props.onDraft(draft)}>
          {draftDefinition(draft).name} — 下書き {draft.revision}
        </button>
      ))}
      {props.writeCatalog && (
        <label>
          部品packを読み込む
          <input
            type="file"
            accept="application/json,.json"
            disabled={props.busy || props.readOnly}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              props.onImport(file);
            }}
          />
        </label>
      )}
    </>
  );
}
