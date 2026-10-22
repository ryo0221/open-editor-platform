import {
  domains,
  expandTemplate,
  type Domain,
  type InputValue,
  type NativeContent,
  type StructureLayout,
  type TemplateDefinition,
  type TemplateKind,
  type TemplateTarget,
} from '@editor-platform/templates';
import { TemplatePreview } from './preview';
import { recent, unitLabel, type GalleryPrepared } from './gallery-model';

export function SamplePreview({
  definition: d,
  compact = false,
  inputs,
}: {
  definition: TemplateDefinition;
  compact?: boolean;
  inputs?: Record<string, InputValue>;
}) {
  try {
    const expanded = expandTemplate(d, inputs ?? d.sample);
    return (
      <TemplatePreview
        domain={d.domain}
        content={expanded.content}
        settings={expanded.settings?.fields}
        compact={compact}
      />
    );
  } catch (e) {
    return <p role="alert">{(e as Error).message}</p>;
  }
}

export function TemplateCard({
  definition: d,
  onSelect,
}: {
  definition: TemplateDefinition;
  onSelect(): void;
}) {
  return (
    <article className="tp-card" onClick={onSelect}>
      <div className="tp-card-art" inert aria-hidden="true">
        <SamplePreview definition={d} compact />
      </div>
      <button type="button" aria-label={`テンプレートを選択: ${d.name}`}>
        <strong>{d.name}</strong>
        <small>
          {d.domain} · {unitLabel(d)} · v{d.templateVersion}
        </small>
        <span>{d.purpose}</span>
        <small>
          {d.structure
            ? `${d.structure.min}〜${d.structure.max}項目・追加後も変更可能`
            : '内容指定は任意'}{' '}
          ·{' '}
          {d.kind === 'whole'
            ? '全体セットを新規作成'
            : d.kind === 'fragment'
              ? `${unitLabel(d)}を追加`
              : 'スタイル・表示設定を適用'}
        </small>
      </button>
    </article>
  );
}

export function TemplateFilters(props: {
  kind: TemplateKind;
  items: TemplateDefinition[];
  query: string;
  domain: Domain | '';
  domainLocked: boolean;
  category: string;
  unit: string;
  recentOnly: boolean;
  onQuery(value: string): void;
  onDomain(value: Domain | ''): void;
  onCategory(value: string): void;
  onUnit(value: string): void;
  onRecent(value: boolean): void;
}) {
  const { kind, items } = props;
  const categories = [...new Set(items.map((d) => d.category))];
  return (
    <div className="tp-filters">
      <label>
        検索
        <input
          aria-label="テンプレート検索"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
        />
      </label>
      <label>
        Editor
        <select
          aria-label="テンプレートのEditor"
          value={props.domain}
          disabled={props.domainLocked}
          onChange={(e) => props.onDomain(e.target.value as Domain | '')}
        >
          <option value="">すべて</option>
          {domains
            .filter((d) => kind === 'preset' || !['review', 'file'].includes(d))
            .map((d) => (
              <option key={d}>{d}</option>
            ))}
        </select>
      </label>
      <label>
        カテゴリー
        <select value={props.category} onChange={(e) => props.onCategory(e.target.value)}>
          <option value="">すべて</option>
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label>
        再利用単位
        <select
          aria-label="テンプレートの再利用単位"
          value={props.unit}
          onChange={(e) => props.onUnit(e.target.value)}
        >
          <option value="">すべて</option>
          {[...new Set(items.map(unitLabel))].map((label) => (
            <option key={label}>{label}</option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={props.recentOnly}
          onChange={(e) => props.onRecent(e.target.checked)}
        />
        最近使ったもの
      </label>
    </div>
  );
}

export function TemplateCards(props: {
  items: TemplateDefinition[];
  recentOnly: boolean;
  unit: string;
  onSelect(definition: TemplateDefinition): void;
}) {
  const { recentOnly, unit } = props;
  return (
    <div className="tp-cards">
      {props.items
        .filter((d) => !recentOnly || recent().includes(d.templateId))
        .filter((d) => !unit || unitLabel(d) === unit)
        .map((d) => (
          <TemplateCard key={d.templateId} definition={d} onSelect={() => props.onSelect(d)} />
        ))}
    </div>
  );
}

export function SelectedTemplateHeading(props: {
  selected: TemplateDefinition;
  kind: TemplateKind;
  items: TemplateDefinition[];
  busy: boolean;
  onBack(): void;
  onVersion(version: number): void;
  onExport(): void;
}) {
  const { selected, kind, busy } = props;
  return (
    <div className="tp-selected-heading">
      <button type="button" disabled={busy} onClick={props.onBack}>
        ← 一覧に戻る
      </button>
      <div>
        <h3>{selected.name}</h3>
        <p>{selected.purpose}</p>
        <p>
          {unitLabel(selected)}。
          {kind === 'fragment'
            ? '追加後は成果物上で直接編集できます。'
            : kind === 'whole'
              ? '新しい成果物を作成します。'
              : '選択範囲のスタイル・個人表示設定を適用します。'}
        </p>
        {selected.composition && (
          <p>
            {selected.kind === 'whole' ? 'Template' : 'Pattern'} · リンク{' '}
            {selected.composition.members.filter((m) => m.reuse === 'linked').length}
            {'部品 / コピー '}
            {selected.composition.members.filter((m) => m.reuse === 'copy').length}
            部品。本文・画像は公開入力で変更できます。
          </p>
        )}
      </div>
      <label>
        版
        <select
          aria-label="テンプレートの版"
          disabled={busy}
          value={selected.templateVersion}
          onChange={(e) => props.onVersion(Number(e.target.value))}
        >
          {Array.from(
            {
              length:
                props.items.find((d) => d.templateId === selected.templateId)?.templateVersion ??
                selected.templateVersion,
            },
            (_, i) => (
              <option key={i} value={i + 1}>
                v{i + 1}
              </option>
            ),
          )}
        </select>
      </label>
      <button type="button" onClick={props.onExport}>
        packを書き出す
      </button>
    </div>
  );
}

export function StructureVariants(props: {
  selected: TemplateDefinition & { structure: NonNullable<TemplateDefinition['structure']> };
  values: Record<string, InputValue>;
  busy: boolean;
  onVary(count: number, layout?: StructureLayout): void;
}) {
  const { selected, values } = props;
  return (
    <fieldset className="tp-variants" disabled={props.busy}>
      <legend>同じ構成の変化を確認</legend>
      {[2, 3, 4]
        .filter((n) => n <= selected.structure.max)
        .map((n) => (
          <button key={n} type="button" onClick={() => props.onVary(n)}>
            {n}項目
          </button>
        ))}
      <label>
        配置
        <select
          aria-label="挿入前の配置"
          value={String(values[selected.structure.layoutSlot])}
          onChange={(e) =>
            props.onVary(
              (values[selected.repeats[selected.structure.repeat].slot] as InputValue[]).length,
              e.target.value as StructureLayout,
            )
          }
        >
          {selected.inputs
            .find((f) => f.key === selected.structure.layoutSlot)
            ?.options?.map((o) => (
              <option key={o} value={o}>
                {o === 'auto' ? '自動' : o === 'horizontal' ? '横' : '縦'}
              </option>
            ))}
        </select>
      </label>
    </fieldset>
  );
}

type Columns = Extract<NativeContent, { columns: unknown }>['columns'];

export function FieldMappingFieldset(props: {
  columns: Columns;
  targetColumns: Columns;
  mapping: TemplateTarget['fieldMapping'];
  onMapping(mapping: TemplateTarget['fieldMapping']): void;
}) {
  const { mapping } = props;
  return (
    <fieldset>
      <legend>field mapping</legend>
      {props.columns.map((c) => (
        <label key={c.id}>
          {c.name} ({c.type})
          <select
            aria-label={`Map ${c.name}`}
            value={typeof mapping?.[c.id] === 'string' ? (mapping[c.id] as string) : ''}
            onChange={(e) =>
              props.onMapping({
                ...mapping,
                [c.id]: e.target.value || { newName: c.name },
              })
            }
          >
            <option value="">新しいfieldを追加 / 明示mapping未選択</option>
            {props.targetColumns.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.type}) · {t.id.slice(-6)}
              </option>
            ))}
          </select>
          {typeof mapping?.[c.id] !== 'string' && (
            <input
              aria-label={`New field name ${c.name}`}
              value={(mapping?.[c.id] as { newName: string } | undefined)?.newName ?? c.name}
              onChange={(e) => props.onMapping({ ...mapping, [c.id]: { newName: e.target.value } })}
            />
          )}
        </label>
      ))}
    </fieldset>
  );
}

function applyLabel(kind: TemplateKind, selected: TemplateDefinition) {
  return kind === 'whole'
    ? 'この内容で作成'
    : kind === 'fragment'
      ? selected.structure
        ? `${selected.structure.unit}を追加`
        : 'この内容を挿入'
      : 'この設定を適用';
}

export function GalleryPreviewColumn(props: {
  selected: TemplateDefinition;
  kind: TemplateKind;
  prepared?: GalleryPrepared;
  values: Record<string, InputValue>;
  busy: boolean;
  onApply(): void;
}) {
  const { selected, prepared } = props;
  return (
    <div className="tp-preview-column">
      <h4>{prepared ? '適用する内容' : '完成サンプル'}</h4>
      {prepared ? (
        <>
          {'application' in prepared &&
            prepared.application.notices.map((notice) => <p key={notice}>{notice}</p>)}
          <TemplatePreview
            key={`prepared-${selected.templateId}`}
            domain={selected.domain}
            content={prepared.content}
            settings={'settings' in prepared ? prepared.settings : undefined}
          />
          {'application' in prepared && prepared.application.mapping.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>元のfield</th>
                  <th>適用先</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {prepared.application.mapping.map((m) => (
                  <tr key={m.sourceId}>
                    <td>
                      {m.sourceName} ({m.sourceType})
                    </td>
                    <td>{m.targetName}</td>
                    <td>{m.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button
            className="primary tp-apply"
            type="button"
            disabled={props.busy}
            onClick={props.onApply}
          >
            {applyLabel(props.kind, selected)}
          </button>
        </>
      ) : (
        <SamplePreview
          definition={selected}
          inputs={selected.structure ? props.values : undefined}
        />
      )}
    </div>
  );
}
