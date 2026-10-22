import { isStructuredData } from '@editor-platform/structured-data/model';
import { isDeck } from '@editor-platform/slide/model';
import { type LockedClosure, type ReuseInstance } from '@editor-platform/reuse-core';
import {
  componentTokenModes,
  prepareComponentDetach,
  prepareComponentProperties,
  reusablePrototype,
  type TemplateCatalog,
  type ComponentDefinition,
  type Domain,
  type NativeContent,
  type PreparedApplication,
  type TemplateTarget,
} from '@editor-platform/templates';
import { DataComponentBindings } from './reuse-data';
import { TemplatePreview } from './preview';
import { ComponentUpdatePanel } from './reuse-update';
import type { SlotDraft } from './reuse-library-hooks';
import { prepareSlotAddition, type LibraryBasis } from './reuse-library-model';

export function ComponentInsertOptions(props: {
  selected: ComponentDefinition;
  content: NativeContent;
  dataTarget: TemplateTarget;
  slidePageId: string;
  reuse: 'linked' | 'copy';
  busy: boolean;
  readOnly: boolean;
  canRevise: boolean;
  canArchive: boolean;
  archived: boolean;
  onDataTarget(value: TemplateTarget): void;
  onSlidePage(id: string): void;
  onReuse(value: 'linked' | 'copy'): void;
  onRevise(): void;
  onExport(): void;
  onArchive(): void;
}) {
  const { selected, content, busy, readOnly } = props;
  return (
    <>
      {isStructuredData(content) && (
        <DataComponentBindings
          definition={selected}
          target={content}
          value={props.dataTarget}
          onChange={props.onDataTarget}
        />
      )}
      {isDeck(content) && selected.payload.slide === 'objects' && (
        <label>
          挿入先ページ
          <select value={props.slidePageId} onChange={(e) => props.onSlidePage(e.target.value)}>
            <option value="">ページを選択</option>
            {content.slides.map((p, i) => (
              <option key={p.id} value={p.id}>
                {i + 1}. {p.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected.domain === 'slide' && (
        <p>
          {selected.payload.slide === 'objects'
            ? '選択したページ内に挿入し、ページ順・本文・ノートを保持します。'
            : 'ページ全体を追加します。寸法の異なるデッキには挿入できません。'}
        </p>
      )}
      {props.canRevise && (
        <button disabled={busy || readOnly} onClick={props.onRevise}>
          新版の下書きを作成
        </button>
      )}
      <button disabled={busy} onClick={props.onExport}>
        部品packを書き出す
      </button>
      <label>
        挿入方法
        <select
          value={props.reuse}
          onChange={(e) => props.onReuse(e.target.value as 'linked' | 'copy')}
        >
          <option value="linked">版を保持してリンク</option>
          <option value="copy">独立したコピー</option>
        </select>
      </label>
      {props.canArchive && (
        <button disabled={busy || readOnly} onClick={props.onArchive}>
          {props.archived ? 'アーカイブから戻す' : '部品をアーカイブ'}
        </button>
      )}
    </>
  );
}

export function ComponentVariantFields(props: {
  selected: ComponentDefinition;
  closure?: LockedClosure<unknown>;
  variant: string;
  mode: string;
  onVariant(value: string): void;
  onMode(value: string): void;
}) {
  const { selected, closure } = props;
  const contract = selected.payload.contract;
  return (
    <>
      <label>
        表示バリエーション
        <select value={props.variant} onChange={(e) => props.onVariant(e.target.value)}>
          <option value="">
            既定
            {contract.defaultVariant
              ? `（${contract.variants.find((v) => v.id === contract.defaultVariant)?.label ?? contract.defaultVariant}）`
              : ''}
          </option>
          {contract.variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </label>
      {closure && componentTokenModes(selected, closure).length > 0 && (
        <label>
          部品のトークンモード
          <select value={props.mode} onChange={(e) => props.onMode(e.target.value)}>
            <option value="">成果物の設定／トークン既定値を継承</option>
            {componentTokenModes(selected, closure).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

export function ComponentSlotFieldset(props: {
  selected: ComponentDefinition;
  items: ComponentDefinition[];
  domain: Domain;
  slotId: string;
  slotText: string;
  slotComponent: string;
  disabled: boolean;
  onSlotId(value: string): void;
  onSlotText(value: string): void;
  onSlotComponent(value: string): void;
  onPreview(): void;
}) {
  const { slotId, slotText, slotComponent } = props;
  return (
    <fieldset>
      <legend>本文・子部品スロット</legend>
      <label>
        追加先スロット
        <select value={slotId} onChange={(e) => props.onSlotId(e.target.value)}>
          <option value="">選択</option>
          {props.selected.payload.contract.slots.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}（最大{s.max}件）
            </option>
          ))}
        </select>
      </label>
      {props.domain === 'document' && (
        <label>
          追加する本文
          <textarea value={slotText} onChange={(e) => props.onSlotText(e.target.value)} />
        </label>
      )}
      <label>
        追加する子部品
        <select value={slotComponent} onChange={(e) => props.onSlotComponent(e.target.value)}>
          <option value="">本文を追加 / 未選択</option>
          {props.items.map((d) => (
            <option key={d.definitionId} value={d.definitionId}>
              {d.name} v{d.version}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={!slotId || props.disabled || (!slotComponent && !slotText)}
        onClick={props.onPreview}
      >
        スロットへの追加をプレビュー
      </button>
    </fieldset>
  );
}

export function PreparedComponentPreview(props: {
  domain: Domain;
  content: NativeContent;
  prepared?: { application: PreparedApplication; token?: string };
  selected?: ComponentDefinition;
  linked: boolean;
  disabled: boolean;
  onApply(): void;
}) {
  const { prepared, selected } = props;
  return prepared ? (
    <>
      <TemplatePreview domain={props.domain} content={prepared.application.preview} />
      {prepared.application.notices.map((n) => (
        <p key={n}>{n}</p>
      ))}
      <button className="primary" disabled={props.disabled} onClick={props.onApply}>
        プレビューした変更を適用
      </button>
    </>
  ) : (
    selected && (
      <TemplatePreview
        domain={props.domain}
        content={props.linked ? props.content : reusablePrototype(selected)}
      />
    )
  );
}

export function ComponentInstanceActions(props: {
  instance: ReuseInstance;
  instances: ReuseInstance[];
  selected: ComponentDefinition;
  content: NativeContent;
  domain: Domain;
  catalog: TemplateCatalog;
  items: ComponentDefinition[];
  disabled: boolean;
  slot: SlotDraft;
  basis(): LibraryBasis;
  onStage(prepared: PreparedApplication): Promise<void>;
  onClear(): void;
  onPrepare(prepare: () => Promise<PreparedApplication> | PreparedApplication): void;
}) {
  const { instance, selected, slot, basis, onClear } = props;
  return (
    <>
      {props.instances.some((value) => value.id === instance.id) && (
        <ComponentUpdatePanel
          key={instance.id}
          instanceId={instance.id}
          content={props.content}
          catalog={props.catalog}
          items={props.items}
          basis={basis}
          disabled={props.disabled}
          onStage={props.onStage}
          onClear={onClear}
        />
      )}
      {selected.payload.contract.slots.length > 0 && (
        <ComponentSlotFieldset
          selected={selected}
          items={props.items}
          domain={props.domain}
          slotId={slot.slotId}
          slotText={slot.slotText}
          slotComponent={slot.slotComponent}
          disabled={props.disabled}
          onSlotId={(value) => {
            slot.setSlotId(value);
            onClear();
          }}
          onSlotText={(value) => {
            slot.setSlotText(value);
            onClear();
          }}
          onSlotComponent={(value) => {
            slot.setSlotComponent(value);
            onClear();
          }}
          onPreview={() =>
            props.onPrepare(() =>
              prepareSlotAddition({
                base: basis(),
                catalog: props.catalog,
                items: props.items,
                instance,
                slotId: slot.slotId,
                slotComponent: slot.slotComponent,
                slotText: slot.slotText,
              }),
            )
          }
        />
      )}
      <button
        disabled={props.disabled}
        onClick={() =>
          props.onPrepare(() =>
            prepareComponentProperties({
              ...basis(),
              instanceId: instance.id,
              reset: selected.payload.contract.properties.map((p) => p.id),
            }),
          )
        }
      >
        入力を既定値に戻す
      </button>
      <button
        disabled={props.disabled}
        onClick={() =>
          props.onPrepare(() => {
            const base = basis();
            return prepareComponentDetach(base.state, base.identity, instance.id);
          })
        }
      >
        リンク解除をプレビュー
      </button>
    </>
  );
}
