import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { reuseInstanceKey } from '@editor-platform/collaboration-adapters';
import type { Action } from '@editor-platform/collaboration-core';
import {
  definitionRef,
  reuseHash,
  rejectReuse,
  resolveComponentProperties,
  type JsonValue,
  type ReuseInstance,
} from '@editor-platform/reuse-core';
import {
  cellValue,
  isStructuredData,
  parseCell,
  validateData,
  type Cell,
  type Column,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import { prepareNativeApplication } from './apply';
import { retainedComponent, reusableNativeActions } from './reuse-apply';
import { materializeComponent, type ComponentDefinition } from './reuse-definition';
import { assertNative, bindDataFormulas, nativeIds, remapNative } from './native';
import type {
  ComponentUpdateOptions,
  ComponentUpdatePreview,
  ComponentUpdateChange,
  ComponentUpdateSelection,
} from './reuse-update';

/** A record reference is a binding, not a copied record or a visual token. */
export function dataRowReferences(data: StructuredData): string[] {
  const relations = new Set(data.columns.filter((c) => c.type === 'relation').map((c) => c.id));
  return [
    ...new Set(
      [
        ...data.columns.filter((c) => relations.has(c.id)).map((c) => c.defaultValue),
        ...(data.views ?? []).flatMap((v) =>
          v.filters
            .filter(
              (f) => relations.has(f.columnId) && !['empty', 'not-empty'].includes(f.operator),
            )
            .map((f) => f.value),
        ),
      ].filter((value): value is string => typeof value === 'string' && !!value),
    ),
  ];
}
export interface DataPartMigration {
  action: 'cast' | 'keep' | 'drop' | 'add';
  /** Optional name for an added field, to resolve name collisions explicitly. */
  name?: string;
  /** Existing string value → explicit target value, e.g. a target record ID. */
  values?: Record<string, Cell>;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const schemaFields = ['type', 'required', 'options', 'formula'];
const columnFields = [
  'name',
  'type',
  'required',
  'defaultValue',
  'options',
  'formula',
  'readOnly',
  'format',
  'decimals',
  'currency',
];
const viewFields = [
  'name',
  'accent',
  'projection',
  'search',
  'filterMode',
  'filters',
  'sorts',
  'groupBy',
  'hidden',
  'widths',
  'frozen',
  'cardFields',
  'chart',
  'timeline',
  'widgets',
  'summary',
];
type Fields = Record<string, unknown>;
const fieldKey = (collection: string, id: string, field: string) =>
  `entity:${collection}:${id}/${field}`;

type AddChange = (
  kind: ComponentUpdateChange['kind'],
  field: string,
  message: string,
  partId?: string,
  before?: unknown,
  after?: unknown,
) => void;
type Retained = ReturnType<typeof retainedComponent>;
type Contract = ComponentDefinition['payload']['contract'];
type Migrations = Record<string, DataPartMigration>;
type View = NonNullable<StructuredData['views']>[number];

function changeRecorder(changes: ComponentUpdateChange[], instanceId: string): AddChange {
  return (kind, field, message, partId, before, after) => {
    changes.push({
      instanceId,
      kind,
      field,
      message,
      ...(partId ? { partId } : {}),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    });
  };
}

/** Shared staging state for every selected Data instance. */
interface DataRun {
  options: ComponentUpdateOptions;
  artifactContext?: { mode?: string };
  source: StructuredData;
  next: StructuredData;
  changes: ComponentUpdateChange[];
  actions: Action[];
  reads: Set<string>;
  requestId: string;
}

/** One adopted Data instance: its mappings and both materialized prototypes. */
interface DataAdoption {
  run: DataRun;
  selection: ComponentUpdateSelection;
  instance: Retained['instance'];
  contract: Contract;
  oldContract: Contract;
  migrations: Migrations;
  inputs: Record<string, JsonValue>;
  add: AddChange;
  ids: Map<string, string>;
  parts: Record<string, string>;
  previous: Map<string, string>;
}

/** Data-specific migration staging; commits through the existing Data codec and finalizer. */
export async function previewDataComponentUpdate(
  options: ComponentUpdateOptions,
  artifactContext?: { mode?: string },
): Promise<ComponentUpdatePreview> {
  const { state } = options;
  if (!isStructuredData(state.content)) rejectReuse('data-schema', 'Expected native Data');
  const source = state.content;
  const run: DataRun = {
    options,
    artifactContext,
    source,
    next: bindDataFormulas(source),
    changes: [],
    actions: [],
    reads: new Set<string>(),
    requestId: options.requestId ?? crypto.randomUUID(),
  };
  const { next, changes, actions, reads } = run;
  // Binding names to IDs is semantic preservation. Protect only formulas actually rewritten.
  for (let i = 0; i < source.columns.length; i++)
    if (source.columns[i].formula !== next.columns[i].formula)
      reads.add(fieldKey('columns', source.columns[i].id, 'formula'));
  for (const selection of options.selections) {
    const retained = retainedComponent(source, selection.instanceId);
    const { instance } = retained;
    const add = changeRecorder(changes, instance.id);
    reads.add(reuseInstanceKey(instance.id));
    if (selection.choice === 'pin') {
      add('preserve', 'version', '現在の版を維持します。');
      continue;
    }
    if (selection.choice === 'detach') {
      actions.push({ type: 'reuse.instance', target: instance.id, payload: { value: null } });
      add('update', 'link', 'レコード・ビューを保持してリンクを解除します。');
      continue;
    }
    await adoptDataSelection(run, selection, retained, add);
  }
  return finishDataUpdate(run);
}

/** Validates the staged Data and prepares the native transaction when nothing conflicts. */
function finishDataUpdate(run: DataRun): ComponentUpdatePreview {
  const { options, next, changes, actions, reads, requestId } = run;
  const { state, identity, definition } = options;
  let conflicts = changes.filter((c) => c.kind === 'conflict');
  if (!conflicts.length && actions.length) {
    for (const error of validateData(next))
      changes.push({
        instanceId: options.selections[0].instanceId,
        kind: 'conflict',
        field: 'cell:' + error.rowId + '/' + error.columnId,
        message: error.message,
      });
    try {
      assertNative('data', next);
    } catch (error) {
      changes.push({
        instanceId: options.selections[0].instanceId,
        kind: 'conflict',
        field: 'references',
        message: (error as Error).message,
      });
    }
    conflicts = changes.filter((c) => c.kind === 'conflict');
  }
  if (conflicts.length || !actions.length) return { changes, conflicts };
  const prepared = prepareNativeApplication({
    state,
    identity,
    id: requestId,
    summary: definition.name + ' のData移行',
    definition: {
      templateId: definition.definitionId,
      templateVersion: definition.version,
      hash: definition.hash,
    },
    actions: [...reusableNativeActions(state, identity, next), ...actions],
    reads: [...reads, 'reuse/mode'],
    notices: [
      '既存のレコードIDを保持します。型変換・項目削除と関連する参照は、このプレビューの一括Undo対象です。',
    ],
  });
  return { changes, conflicts, prepared };
}

/** Retains inputs whose mapped property keeps its type. */
function mapDataInputs(
  selection: ComponentUpdateSelection,
  instance: Retained['instance'],
  contract: Contract,
  oldContract: Contract,
  add: AddChange,
) {
  const inputs: Record<string, JsonValue> = {};
  for (const [id, value] of Object.entries(instance.inputs)) {
    const to = selection.inputMapping?.[id] ?? id;
    if (
      !contract.properties.some(
        (p) => p.id === to && p.type === oldContract.properties.find((p) => p.id === id)?.type,
      ) ||
      Object.hasOwn(inputs, to)
    )
      add('conflict', 'input:' + id, '入力を保持できる対応先が必要です。');
    else inputs[to] = clone(value);
  }
  return inputs;
}

/** Rejects migration selections for unknown parts or with malformed values. */
function validateDataMigrations(contract: Contract, oldContract: Contract, migrations: Migrations) {
  for (const [id, migration] of Object.entries(migrations))
    if (
      (!oldContract.parts.some((p) => p.id === id) && !contract.parts.some((p) => p.id === id)) ||
      !migration ||
      !['cast', 'keep', 'drop', 'add'].includes(migration.action) ||
      Object.keys(migration).some((k) => !['action', 'name', 'values'].includes(k)) ||
      (migration.values &&
        Object.values(migration.values).some(
          (v) => v !== null && !['string', 'number', 'boolean'].includes(typeof v),
        ))
    )
      rejectReuse('data-migration', 'Invalid or unknown Data migration selection', {
        partId: id,
      });
}

/** A definition identity change requires an explicit swap. */
function assertDataIdentity(options: ComponentUpdateOptions, old: Retained['definition']) {
  const { definition } = options;
  if (
    !options.swap &&
    (old.libraryId !== definition.libraryId || old.definitionId !== definition.definitionId)
  )
    rejectReuse('update-identity', 'Changing definition identity requires explicit swap');
}

/** Stages one `adopt` selection; any conflict leaves the instance unstaged. */
async function adoptDataSelection(
  run: DataRun,
  selection: ComponentUpdateSelection,
  retained: Retained,
  add: AddChange,
) {
  const { options, changes } = run;
  const { definition } = options;
  const { instance, definition: old } = retained;
  const start = changes.length;
  const conflicted = () => changes.slice(start).some((c) => c.kind === 'conflict');
  assertDataIdentity(options, old);
  if (old.payload.data !== definition.payload.data) {
    add(
      'conflict',
      'capability',
      '項目セットとビュー設定は異なる能力です。旧版を維持するかリンクを解除してください。',
    );
    return;
  }
  const contract = definition.payload.contract,
    oldContract = old.payload.contract;
  const inputs = mapDataInputs(selection, instance, contract, oldContract, add);
  const variant = selection.variant === null ? undefined : (selection.variant ?? instance.variant);
  try {
    resolveComponentProperties(contract, inputs, variant);
  } catch (error) {
    add('conflict', 'inputs', (error as Error).message);
  }
  const migrations = selection.dataMigration ?? {};
  validateDataMigrations(contract, oldContract, migrations);
  if (conflicted()) return;
  const mode = selection.mode === null ? undefined : (selection.mode ?? instance.mode);
  const { oldRaw, raw } = await materializeDataPrototypes(run, retained, inputs, variant, mode);
  const adoption: DataAdoption = {
    run,
    selection,
    instance,
    contract,
    oldContract,
    migrations,
    inputs,
    add,
    ids: new Map(Object.entries(instance.nativeIds ?? {})),
    parts: {},
    previous: new Map<string, string>(),
  };
  const { ids } = adoption;
  for (const oldPart of oldContract.parts) mapDataPart(adoption, oldPart.id);
  mapDataBindings(adoption, raw);
  if (conflicted()) return;
  const incoming = remapNative(
    raw,
    ids,
    'ru_' + reuseHash(run.requestId + instance.id).slice(0, 32),
  ).content;
  const base = remapNative(oldRaw, new Map(Object.entries(instance.nativeIds ?? {}))).content;
  for (const part of contract.parts) mergeDataPart(adoption, part, incoming, base);
  if (conflicted()) return;
  const value = adoptedDataInstance(adoption, raw, variant, mode);
  run.actions.push({
    type: 'reuse.instance',
    target: instance.id,
    payload: { value, closure: options.closure },
  });
  add('update', 'version', `v${old.version} → v${definition.version} を採用します。`);
}

/** Materializes the retained and selected versions as native Data prototypes. */
async function materializeDataPrototypes(
  run: DataRun,
  retained: Retained,
  inputs: Record<string, JsonValue>,
  variant: string | undefined,
  mode: string | undefined,
) {
  const { options, artifactContext, source } = run;
  const { instance, definition: old, closure: oldClosure } = retained;
  const oldRaw = (
    await materializeComponent(
      old,
      oldClosure,
      instance.inputs,
      instance.variant,
      instance.mode,
      source.reuse?.artifactMode,
    )
  ).content;
  const raw = (
    await materializeComponent(
      options.definition,
      options.closure,
      inputs,
      variant,
      mode,
      artifactContext ? artifactContext.mode : source.reuse?.artifactMode,
    )
  ).content;
  if (!isStructuredData(oldRaw) || !isStructuredData(raw))
    rejectReuse('data-schema', 'Native Data prototype missing');
  return { oldRaw, raw };
}

/** The adopted instance record with only the native IDs the new prototype still uses. */
function adoptedDataInstance(
  adoption: DataAdoption,
  raw: StructuredData,
  variant: string | undefined,
  mode: string | undefined,
) {
  const { run, selection, instance, inputs, ids, parts, previous } = adoption;
  const { definition, closure } = run.options;
  const usedIds = new Set([...nativeIds(raw), ...dataRowReferences(raw)]);
  const value: ReuseInstance = {
    ...clone(instance),
    ref: definitionRef(definition),
    closureHash: closure.hash,
    parts,
    nativeIds: Object.fromEntries([...ids].filter(([key]) => usedIds.has(key))),
    inputs,
    slots: {},
    overrides: Object.fromEntries(
      Object.entries(instance.overrides)
        .filter(([id]) => previous.has(selection.partMapping?.[id] ?? id))
        .map(([id, v]) => [selection.partMapping?.[id] ?? id, v]),
    ),
    ...(variant ? { variant } : {}),
  };
  if (mode === undefined) delete value.mode;
  else value.mode = mode;
  if (variant === undefined) delete value.variant;
  return value;
}

/** Maps one retained part onto the new contract, or stages its explicit removal. */
function mapDataPart(adoption: DataAdoption, oldPartId: string) {
  const { selection, instance, contract, add, ids, parts, previous } = adoption;
  const to = selection.partMapping?.[oldPartId] ?? oldPartId,
    incoming = contract.parts.find((p) => p.id === to);
  if (!incoming) return removeDataPart(adoption, oldPartId);
  if (parts[to]) {
    add('conflict', 'mapping', '項目を同じ対応先へまとめることはできません。', oldPartId);
    return;
  }
  parts[to] = instance.parts[oldPartId];
  ids.set(incoming.nativeId, parts[to]);
  previous.set(to, oldPartId);
}

/** Keeps or drops a part the new version no longer declares. */
function removeDataPart(adoption: DataAdoption, oldPartId: string) {
  const { run, instance, migrations, add } = adoption;
  const { source, next, reads } = run;
  const migration = migrations[oldPartId],
    nativeId = instance.parts[oldPartId];
  if (!migration || !['keep', 'drop'].includes(migration.action)) {
    add(
      'conflict',
      'remove',
      '削除された項目・ビューをローカルに保持するか、明示的に削除してください。',
      oldPartId,
    );
    return;
  }
  if (migration.action === 'keep') {
    add('preserve', 'remove', '内容を独立したローカル項目・ビューとして保持します。', oldPartId);
    return;
  }
  if (
    source.reuse?.instances.some(
      (i) => i.id !== instance.id && Object.values(i.parts).includes(nativeId),
    )
  ) {
    add('conflict', 'remove', '対象外のリンク部品も使用しています。削除できません。', oldPartId);
    return;
  }
  if (next.columns.some((c) => c.id === nativeId)) {
    next.columns = next.columns.filter((c) => c.id !== nativeId);
    next.rows.forEach((r) => {
      delete r.values[nativeId];
    });
    reads.add('order:rows');
    reads.add('order:views');
    source.rows.forEach((r) => reads.add(fieldKey('rows', r.id, 'values/' + nativeId)));
    source.views?.forEach((v) => reads.add('entity:views:' + v.id));
  } else next.views = next.views?.filter((v) => v.id !== nativeId);
  add(
    'update',
    'remove',
    '確認された項目・値／ビューを削除します。参照が残る場合は適用を保留します。',
    oldPartId,
  );
}

/** Checks view field bindings, explicit additions and referenced records. */
function mapDataBindings(adoption: DataAdoption, raw: StructuredData) {
  const { run, selection, instance, contract, migrations, add, ids, parts } = adoption;
  const { options, source } = run;
  // A view owns no bound columns, but retains their exact native field IDs.
  for (const column of raw.columns)
    if (
      options.definition.payload.data === 'view' &&
      (!ids.get(column.id) ||
        !source.columns.some((c) => c.id === ids.get(column.id) && c.type === column.type))
    )
      add(
        'conflict',
        'binding',
        '新版のビュー項目を対応付けできません。明示的な再挿入か旧版維持が必要です。',
        undefined,
        column.id,
      );
  for (const part of contract.parts)
    if (!parts[part.id]) {
      if (migrations[part.id]?.action !== 'add') {
        add('conflict', 'add', '追加する項目・ビューを明示的に選んでください。', part.id);
        continue;
      }
      ids.delete(part.nativeId); // Newly owned entities never reuse removed mappings by accident.
    }
  for (const rowId of dataRowReferences(raw)) {
    const target = selection.rowMapping?.[rowId] ?? instance.nativeIds?.[rowId];
    if (!source.rows.some((r) => r.id === target))
      add('conflict', 'row:' + rowId, '参照する既存レコードを明示してください。');
    else ids.set(rowId, target!);
  }
}

/** The incoming and staged column or view with one native ID. */
function dataPartEntities(incoming: StructuredData, next: StructuredData, nativeId: string) {
  const newColumn = incoming.columns.find((c) => c.id === nativeId),
    currentColumn = next.columns.find((c) => c.id === nativeId);
  const newView = incoming.views?.find((v) => v.id === nativeId),
    currentView = next.views?.find((v) => v.id === nativeId);
  return {
    newColumn,
    currentColumn,
    newView,
    currentView,
    newPart: newColumn ?? newView,
    localPart: currentColumn ?? currentView,
  };
}

/** The staged, incoming and base entities of one contract part; undefined when none merge. */
function dataPartTarget(
  adoption: DataAdoption,
  part: Contract['parts'][number],
  incoming: StructuredData,
  base: StructuredData,
) {
  const { run, instance, migrations, add, ids, parts, previous } = adoption;
  const nativeId = ids.get(part.nativeId)!,
    oldPartId = previous.get(part.id),
    migration = migrations[oldPartId ?? part.id];
  parts[part.id] = nativeId;
  const { newColumn, currentColumn, newView, currentView, newPart, localPart } = dataPartEntities(
    incoming,
    run.next,
    nativeId,
  );
  if (!newPart) {
    add('conflict', 'part', '新版のnative項目がありません。', part.id);
    return;
  }
  if (!oldPartId) {
    if (migration?.action === 'add') addDataPart(adoption, part.id, migration, newColumn, newView);
    return;
  }
  const oldNativeId = instance.parts[oldPartId],
    beforeColumn = base.columns.find((c) => c.id === oldNativeId);
  const before = beforeColumn ?? base.views?.find((v) => v.id === oldNativeId);
  if (!before || !localPart || !!beforeColumn !== !!newColumn || !!currentColumn !== !!newColumn) {
    add('conflict', 'part', '現在の項目・ビューの種類や対応先が変わっています。', part.id);
    return;
  }
  return {
    nativeId,
    oldPartId,
    migration,
    newColumn,
    currentColumn,
    currentView,
    before: before as unknown as Fields,
    newPart: newPart as unknown as Fields,
    localPart: localPart as unknown as Fields,
  };
}

/** Three-way merges one contract part into the staged Data. */
function mergeDataPart(
  adoption: DataAdoption,
  part: Contract['parts'][number],
  incoming: StructuredData,
  base: StructuredData,
) {
  const target = dataPartTarget(adoption, part, incoming, base);
  if (!target) return;
  const { nativeId, oldPartId, migration, newColumn, currentColumn, currentView } = target;
  const { next } = adoption.run;
  const bound = !!adoption.instance.overrides[oldPartId]?.schema;
  const schemaChanged =
    !!newColumn && schemaFields.some((f) => !same(target.before[f], target.newPart[f]));
  const unbound = schemaChanged && !bound,
    action = migration?.action;
  if (unbound && !['cast', 'keep'].includes(action ?? '')) {
    adoption.add(
      'conflict',
      'schema',
      '型・制約・数式の変更を確認し、値を変換するか現行項目を保持してください。',
      part.id,
    );
    return;
  }
  const merged = mergeDataFields(adoption, part.id, nativeId, {
    ...target,
    column: !!newColumn,
    preserveSchema: !!newColumn && (bound || action === 'keep'),
  });
  if (newColumn && currentColumn) {
    const finalColumn = merged as unknown as Column;
    if (unbound && action === 'cast')
      castDataColumn(adoption, part.id, nativeId, currentColumn, finalColumn, migration!);
    next.columns[next.columns.indexOf(currentColumn)] = finalColumn;
  } else next.views![next.views!.indexOf(currentView!)] = merged as unknown as View;
}

/** Appends an explicitly added column or view with default row values. */
function addDataPart(
  adoption: DataAdoption,
  partId: string,
  migration: DataPartMigration,
  newColumn: Column | undefined,
  newView: View | undefined,
) {
  const { next, reads } = adoption.run;
  if (newColumn) {
    if (migration.name !== undefined) newColumn.name = migration.name;
    next.columns.push(clone(newColumn));
    if (newColumn.type !== 'formula')
      next.rows.forEach((r) => {
        r.values[newColumn.id] =
          newColumn.defaultValue ?? (newColumn.type === 'boolean' ? false : null);
      });
    reads.add('order:rows');
  } else {
    next.views ??= [];
    next.views.push(clone(newView!));
  }
  adoption.add(
    'update',
    'add',
    '新しい項目・ビューを追加します。既存レコードIDは保持します。',
    partId,
  );
}

/** Adopts changed fields that carry no binding, public input or local edit. */
function mergeDataFields(
  adoption: DataAdoption,
  partId: string,
  nativeId: string,
  part: {
    before: Fields;
    newPart: Fields;
    localPart: Fields;
    column: boolean;
    preserveSchema: boolean;
  },
) {
  const { run, contract, inputs, add } = adoption;
  const { before, newPart, localPart } = part;
  const collection = part.column ? 'columns' : 'views',
    fields = part.column ? columnFields : viewFields;
  const merged = clone(localPart);
  for (const field of fields) {
    const a = before[field],
      b = newPart[field],
      local = localPart[field];
    if (same(a, b)) continue;
    run.reads.add(fieldKey(collection, nativeId, field));
    const owned = contract.properties.some(
      (p) =>
        Object.hasOwn(inputs, p.id) &&
        p.targets.some((t) => t.partId === partId && t.field === field),
    );
    if (part.preserveSchema || owned || !same(local, a)) {
      add(
        'preserve',
        field,
        '既存項目へのbinding・公開input・ローカル編集を保持します。',
        partId,
        local,
        b,
      );
      continue;
    }
    if (b === undefined) delete merged[field];
    else merged[field] = clone(b);
    add('update', field, '新版の属性を採用します。', partId, local, b);
  }
  return merged;
}

/** Converts every row's value for a column whose schema changed under an explicit cast. */
function castDataColumn(
  adoption: DataAdoption,
  partId: string,
  nativeId: string,
  currentColumn: Column,
  finalColumn: Column,
  migration: DataPartMigration,
) {
  const { add } = adoption;
  const { source, next, reads } = adoption.run;
  reads.add('order:rows');
  reads.add('schema');
  for (const row of next.rows) {
    const original = source.rows.find((r) => r.id === row.id)!;
    let value: Cell;
    try {
      value = cellValue(source, original, source.columns.find((c) => c.id === nativeId)!);
    } catch (error) {
      add('conflict', 'cell:' + row.id, (error as Error).message, partId);
      continue;
    }
    // Formula materialization reads its transitive inputs; protect all fields in that row.
    const dependencies =
      currentColumn.type === 'formula' ? source.columns.map((c) => c.id) : [nativeId];
    dependencies.forEach((id) => reads.add(fieldKey('rows', row.id, 'values/' + id)));
    if (finalColumn.type === 'formula') delete row.values[nativeId];
    else
      row.values[nativeId] =
        typeof value === 'string' && migration.values && Object.hasOwn(migration.values, value)
          ? migration.values[value]
          : finalColumn.type === currentColumn.type
            ? value
            : parseCell(String(value ?? ''), finalColumn);
    if (!same(original.values[nativeId], row.values[nativeId]))
      add(
        'update',
        'cell:' + row.id,
        'レコードを保持して値を変換します。',
        partId,
        original.values[nativeId],
        row.values[nativeId],
      );
  }
}
