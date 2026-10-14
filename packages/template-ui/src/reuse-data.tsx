import { isStructuredData, type StructuredData } from '@editor-platform/structured-data/model';
import {
  dataRowReferences,
  reusablePrototype,
  retainedComponent,
  type ComponentDefinition,
  type ComponentUpdateSelection,
  type TemplateTarget,
} from '@editor-platform/templates';
function Records({ data }: { data: StructuredData }) {
  return (
    <>
      {data.rows.map((r, index) => (
        <option key={r.id} value={r.id}>
          {index + 1}. {String(Object.values(r.values).find((v) => typeof v === 'string') ?? r.id)}
        </option>
      ))}
    </>
  );
}
export function DataComponentBindings(props: {
  definition: ComponentDefinition;
  target: StructuredData;
  value: TemplateTarget;
  onChange(value: TemplateTarget): void;
}) {
  const source = reusablePrototype(props.definition);
  if (!isStructuredData(source)) return null;
  return (
    <fieldset>
      <legend>項目と参照レコードの対応付け</legend>
      <p>既存レコードを保持します。部品にサンプル行は含めません。</p>
      {source.columns.map((c) => (
        <div key={c.id}>
          <label>
            項目の対応先: {c.name}
            <select
              value={
                typeof props.value.fieldMapping?.[c.id] === 'string'
                  ? (props.value.fieldMapping[c.id] as string)
                  : ''
              }
              onChange={(e) =>
                props.onChange({
                  ...props.value,
                  fieldMapping: {
                    ...props.value.fieldMapping,
                    [c.id]: e.target.value || { newName: c.name },
                  },
                })
              }
            >
              <option value="">
                {props.definition.payload.data === 'view' ? '対応先を選択' : '新しい項目を追加'}
              </option>
              {props.target.columns
                .filter((t) => t.type === c.type)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.type})
                  </option>
                ))}
            </select>
          </label>
          {typeof props.value.fieldMapping?.[c.id] !== 'string' &&
            props.definition.payload.data !== 'view' && (
              <label>
                追加する項目名: {c.name}
                <input
                  value={
                    (props.value.fieldMapping?.[c.id] as { newName: string } | undefined)
                      ?.newName ?? c.name
                  }
                  onChange={(e) =>
                    props.onChange({
                      ...props.value,
                      fieldMapping: {
                        ...props.value.fieldMapping,
                        [c.id]: { newName: e.target.value },
                      },
                    })
                  }
                />
              </label>
            )}
        </div>
      ))}
      {dataRowReferences(source).map((id) => (
        <label key={id}>
          参照レコードの対応先: {id}
          <select
            value={props.value.rowMapping?.[id] ?? ''}
            onChange={(e) =>
              props.onChange({
                ...props.value,
                rowMapping: { ...props.value.rowMapping, [id]: e.target.value },
              })
            }
          >
            <option value="">既存レコードを選択</option>
            <Records data={props.target} />
          </select>
        </label>
      ))}
    </fieldset>
  );
}
export function DataMigrationForm(props: {
  old: ComponentDefinition;
  next: ComponentDefinition;
  current: StructuredData;
  selection: ComponentUpdateSelection;
  onChange(value: ComponentUpdateSelection): void;
}) {
  const a = reusablePrototype(props.old),
    b = reusablePrototype(props.next);
  if (!isStructuredData(a) || !isStructuredData(b)) return null;
  const { selection } = props;
  const instance = retainedComponent(props.current, selection.instanceId).instance;
  const set = (id: string, action: string) => {
    const dataMigration = { ...selection.dataMigration };
    if (!action) delete dataMigration[id];
    else dataMigration[id] = { action: action as 'cast' | 'keep' | 'drop' | 'add' };
    props.onChange({ ...selection, dataMigration });
  };
  return (
    <fieldset>
      <legend>Dataの移行</legend>
      <p>
        型・制約の変更、項目の追加・削除は選択してから差分を確認します。変換できない値や参照が残る場合は保留します。
      </p>
      {props.old.payload.contract.parts.map((part) => {
        const after = props.next.payload.contract.parts.find(
          (p) => p.id === (selection.partMapping?.[part.id] ?? part.id),
        );
        const before =
          a.columns.find((c) => c.id === part.nativeId) ??
          a.views?.find((v) => v.id === part.nativeId);
        const incoming = b.columns.find((c) => c.id === after?.nativeId);
        const nativeId = instance.parts[part.id];
        const values = [
          ...new Set(
            props.current.rows
              .map((r) => r.values[nativeId])
              .filter((value): value is string => typeof value === 'string' && !!value),
          ),
        ];
        return (
          <div key={part.id}>
            <label>
              移行: {before?.name ?? part.id}
              <select
                value={selection.dataMigration?.[part.id]?.action ?? ''}
                onChange={(e) => set(part.id, e.target.value)}
              >
                <option value="">差分を確認・未選択</option>
                <option value="keep">現在の項目・値を保持</option>
                {after ? (
                  <option value="cast">型・制約を採用して値を変換</option>
                ) : (
                  <option value="drop">項目と値／ビューを削除</option>
                )}
              </select>
            </label>
            {incoming?.type === 'relation' &&
              selection.dataMigration?.[part.id]?.action === 'cast' &&
              values.map((value) => (
                <label key={value}>
                  レコードへ対応: {before?.name} / {value}
                  <select
                    value={String(selection.dataMigration?.[part.id]?.values?.[value] ?? '')}
                    onChange={(e) => {
                      const migration = selection.dataMigration![part.id];
                      const mapped = { ...migration.values };
                      if (e.target.value) mapped[value] = e.target.value;
                      else delete mapped[value];
                      props.onChange({
                        ...selection,
                        dataMigration: {
                          ...selection.dataMigration,
                          [part.id]: { ...migration, values: mapped },
                        },
                      });
                    }}
                  >
                    <option value="">未選択・元の値を検証</option>
                    <Records data={props.current} />
                  </select>
                </label>
              ))}
          </div>
        );
      })}
      {props.next.payload.contract.parts
        .filter(
          (p) =>
            !props.old.payload.contract.parts.some(
              (old) => (selection.partMapping?.[old.id] ?? old.id) === p.id,
            ),
        )
        .map((part) => (
          <div key={part.id}>
            <label>
              追加:{' '}
              {b.columns.find((c) => c.id === part.nativeId)?.name ??
                b.views?.find((v) => v.id === part.nativeId)?.name ??
                part.id}
              <select
                value={selection.dataMigration?.[part.id]?.action ?? ''}
                onChange={(e) => set(part.id, e.target.value)}
              >
                <option value="">保留</option>
                <option value="add">項目・ビューを追加</option>
              </select>
            </label>
            {b.columns.some((c) => c.id === part.nativeId) &&
              selection.dataMigration?.[part.id]?.action === 'add' && (
                <label>
                  新版で追加する項目名
                  <input
                    value={
                      selection.dataMigration?.[part.id]?.name ??
                      b.columns.find((c) => c.id === part.nativeId)!.name
                    }
                    onChange={(e) =>
                      props.onChange({
                        ...selection,
                        dataMigration: {
                          ...selection.dataMigration,
                          [part.id]: { ...selection.dataMigration![part.id], name: e.target.value },
                        },
                      })
                    }
                  />
                </label>
              )}
          </div>
        ))}
      {dataRowReferences(b).map((id) => (
        <label key={id}>
          新版の参照レコード: {id}
          <select
            value={selection.rowMapping?.[id] ?? ''}
            onChange={(e) =>
              props.onChange({
                ...selection,
                rowMapping: { ...selection.rowMapping, [id]: e.target.value },
              })
            }
          >
            <option value="">以前の対応先を保持</option>
            <Records data={props.current} />
          </select>
        </label>
      ))}
    </fieldset>
  );
}
