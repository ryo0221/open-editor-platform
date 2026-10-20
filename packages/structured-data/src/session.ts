import {
  canonicalJson,
  clone,
  contentHash,
  isDeepFrozen,
  type Artifact,
} from '@editor-platform/artifact-core';
import { EditorSession, command, type EditorCommand } from '@editor-platform/editor-core';
import { isStructuredData, makeRow, type StructuredData } from './model';
import { columnSchemaIntent, columnSchemaCommand } from './schema-command';
export interface DataVersionSource {
  artifact: Artifact<StructuredData>;
  revision: string;
  readOnly: boolean;
}
const versionRestores = new WeakMap<
  EditorCommand<StructuredData>,
  (current: StructuredData, next?: StructuredData) => void
>();
/** Host-owned saved-version lookup; command names never grant restoration privileges. */
export async function restoreDataVersion(
  versionId: string,
  read: () => DataVersionSource,
): Promise<EditorCommand<StructuredData>> {
  const source = read();
  if (source.readOnly) throw new Error('Data is read only');
  const artifact = clone(source.artifact),
    base = canonicalJson(artifact),
    revision = source.revision;
  if (artifact.kind !== 'data' || !artifact.id || !revision)
    throw new Error('Expected a revision-bound Data artifact');
  const matches = artifact.versions.filter((v) => v.versionId === versionId),
    version = matches[0];
  if (matches.length !== 1 || version.artifactId !== artifact.id)
    throw new Error('Saved Data version does not belong to this artifact');
  assertDataReadable(artifact.draft.content);
  assertDataReadable(version.content);
  if ((await contentHash(version.content)) !== version.contentHash)
    throw new Error('Saved Data version content hash mismatch');
  const check = (current: StructuredData, next?: StructuredData) => {
    const latest = read();
    if (latest.readOnly) throw new Error('Data is read only');
    if (
      latest.revision !== revision ||
      canonicalJson(latest.artifact) !== base ||
      canonicalJson(current) !== canonicalJson(artifact.draft.content)
    )
      throw new Error('Saved Data restoration is stale; artifact, version or draft changed');
    if (next !== undefined && canonicalJson(next) !== canonicalJson(version.content))
      throw new Error('Restoration must use the exact verified saved Data content');
  };
  check(artifact.draft.content);
  const cmd = Object.freeze(
    command<StructuredData>('data.restore-version', 'Restore saved Data version', (current) => {
      check(current);
      return clone(version.content);
    }),
  );
  versionRestores.set(cmd, check);
  return cmd;
}
/** Integrity belongs to Data, and remains active without a Graph surface. */
export function assertDataReadable(data: unknown): asserts data is StructuredData {
  if (!isStructuredData(data)) throw new Error('Invalid Data structure or Graph view settings');
  if (
    data.rows.some((r) =>
      Object.values(r.values).some((v) => typeof v === 'number' && !Number.isFinite(v)),
    )
  )
    throw new Error('Data cells must contain finite numbers');
}
function unresolvedReferences(data: StructuredData) {
  const result = new Map<string, string>();
  const relations = data.columns.filter((c) => c.type === 'relation');
  if (!relations.length) return result;
  const ids = new Set(data.rows.map((r) => r.id));
  for (const row of data.rows)
    for (const c of relations) {
      const value = row.values[c.id];
      if (
        c.type === 'relation' &&
        value !== undefined &&
        value !== null &&
        value !== '' &&
        (typeof value !== 'string' || !ids.has(value))
      )
        result.set(canonicalJson([row.id, c.id]), canonicalJson(value));
    }
  return result;
}
/** Strict projection/publication boundary; readable legacy drafts can still be repaired. */
export function assertDataIntegrity(data: unknown): asserts data is StructuredData {
  assertDataReadable(data);
  if (unresolvedReferences(data).size) throw new Error('Choose an existing record in this dataset');
}
export function guardDataCommand(
  cmd: EditorCommand<StructuredData>,
  writable: () => boolean = () => true,
): EditorCommand<StructuredData> {
  const schemaIntent = columnSchemaIntent(cmd);
  const restoration = versionRestores.get(cmd);
  const guarded: EditorCommand<StructuredData> = {
    ...cmd,
    readonlyInput: cmd.readonlyInput,
    apply(current) {
      if (!writable()) throw new Error('Data is read only');
      assertDataReadable(current);
      restoration?.(current);
      const retained = unresolvedReferences(current);
      // Reuse only an already certified immutable input for a command that
      // declares the existing read-only contract. Mutable callers stay isolated.
      const next = cmd.apply(cmd.readonlyInput && isDeepFrozen(current) ? current : clone(current));
      assertDataReadable(next);
      if (restoration) {
        restoration(current, next);
        return next;
      }
      for (const [address, value] of unresolvedReferences(next))
        if (retained.get(address) !== value)
          throw new Error('Choose an existing record in this dataset');
      const existingIds = new Set(current.rows.map((r) => r.id)),
        added = next.rows.filter((r) => !existingIds.has(r.id));
      if (added.length) {
        const previous = new Map(current.columns.map((c) => [c.id, c])),
          protectedColumns = next.columns.map((column) => {
            const original = previous.get(column.id);
            return original?.readOnly || original?.type === 'formula' ? original : column;
          }),
          defaults = makeRow({ ...next, columns: protectedColumns }, 'defaults').values;
        for (const column of protectedColumns.filter((c) => c.readOnly || c.type === 'formula'))
          for (const row of added)
            if (
              Object.hasOwn(row.values, column.id) !== Object.hasOwn(defaults, column.id) ||
              canonicalJson(row.values[column.id]) !== canonicalJson(defaults[column.id])
            )
              throw new Error(
                `${column.name}: New records must retain read-only defaults and omit formula values`,
              );
      }
      for (const column of current.columns) {
        const updated = next.columns.find((c) => c.id === column.id);
        if (
          column.readOnly &&
          canonicalJson(updated) !== canonicalJson(column) &&
          !(
            schemaIntent?.columnId === column.id &&
            schemaIntent.kind === (updated ? 'update' : 'remove')
          )
        )
          throw new Error(`${column.name} is read only`);
        if (
          column.type === 'relation' &&
          (!updated || updated.type !== 'relation') &&
          current.rows.some(
            (r) =>
              r.values[column.id] !== undefined &&
              r.values[column.id] !== null &&
              r.values[column.id] !== '',
          )
        )
          throw new Error('Disconnect relations before changing or deleting their field');
        if (column.readOnly || column.type === 'formula')
          for (const row of current.rows) {
            const target = next.rows.find((r) => r.id === row.id);
            if (
              target &&
              (Object.hasOwn(target.values, column.id) !== Object.hasOwn(row.values, column.id) ||
                canonicalJson(target.values[column.id]) !== canonicalJson(row.values[column.id])) &&
              !(
                schemaIntent?.columnId === column.id &&
                schemaIntent.kind === 'remove' &&
                !updated &&
                !Object.hasOwn(target.values, column.id)
              ) &&
              !(
                schemaIntent?.columnId === column.id &&
                schemaIntent.kind === 'update' &&
                column.type === 'formula' &&
                !column.readOnly &&
                updated &&
                updated.type !== 'formula' &&
                !updated.readOnly
              )
            )
              throw new Error(`${column.name} is read only`);
          }
      }
      // A required relation cannot silently become empty during cascade deletion.
      for (const column of next.columns.filter((c) => c.type === 'relation' && c.required))
        for (const row of next.rows) {
          const original = current.rows.find((r) => r.id === row.id)?.values[column.id];
          if (original && !row.values[column.id])
            throw new Error(`${column.name}: Required relation cannot be removed`);
        }
      return next;
    },
  };
  if (restoration) versionRestores.set(guarded, restoration);
  return schemaIntent
    ? columnSchemaCommand(schemaIntent.columnId, schemaIntent.kind, guarded)
    : guarded;
}
/** The canonical local executor shared by every Data projection and headless callers. */
export class DataSession extends EditorSession<StructuredData> {
  readOnly = false;
  constructor(data: StructuredData) {
    assertDataReadable(data);
    super(data);
  }
  override executeView(cmd: EditorCommand<StructuredData>) {
    return super.executeView(guardDataCommand(cmd, () => !this.readOnly));
  }
  override undo() {
    if (this.readOnly) throw new Error('Data is read only');
    return super.undo();
  }
  override redo() {
    if (this.readOnly) throw new Error('Data is read only');
    return super.redo();
  }
}

/** Pin private input buffers to the row and schema they were opened against. */
export function pinDataCommand(
  cmd: EditorCommand<StructuredData>,
  target: { rowId: string; row: string; columns: string },
): EditorCommand<StructuredData> {
  return {
    ...cmd,
    apply(current) {
      const row = current.rows.find((r) => r.id === target.rowId);
      if (
        !row ||
        canonicalJson(row) !== target.row ||
        canonicalJson(current.columns) !== target.columns
      )
        throw new Error(
          'This record or schema changed while editing. Cancel to reload current values.',
        );
      return cmd.apply(current);
    },
  };
}
