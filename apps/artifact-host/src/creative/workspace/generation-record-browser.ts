import { canonicalJson, clone } from '@editor-platform/artifact-core';
import {
  readCreativeWorldExecutionRecord,
  type CreativeWorldRecordStorage,
} from './generation-record';

/** Reference Host storage, alongside its existing browser mappings. Single-user only;
 * production Hosts supply their existing authorized CAS execution-record storage. */
export function createBrowserCreativeWorldRecords(
  namespace: string,
  mayRead: (artifactId: string) => boolean,
  mayWrite: () => boolean,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): CreativeWorldRecordStorage {
  const key = (artifactId: string) =>
    `creative-design:world-executions:${encodeURIComponent(namespace)}:${encodeURIComponent(artifactId)}`;
  const list = (requested: string, artifactId: string) => {
    if (requested !== namespace || mayRead(artifactId) !== true)
      throw Error('実行記録の作品・閲覧権限が不正です。');
    const raw = storage.getItem(key(artifactId));
    const array: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(array) || array.length > 256)
      throw Error('実行記録の保存形式・件数が不正です。');
    const rows = array.map(readCreativeWorldExecutionRecord);
    if (
      new Set(rows.map((r) => r.operationId)).size !== rows.length ||
      rows.some(
        (r) =>
          r.namespace !== namespace ||
          r.scope.artifactId !== artifactId ||
          r.context.references.some((ref) => mayRead(ref.reference.artifactId) !== true),
      )
    )
      throw Error('実行記録の対象・権限・重複が不正です。');
    return rows;
  };
  return {
    list: async (requested, artifactId) => clone(list(requested, artifactId)),
    async write(raw, expected) {
      const record = readCreativeWorldExecutionRecord(raw);
      if (mayWrite() !== true) throw Error('実行記録の編集権限がありません。');
      const rows = list(record.namespace, record.scope.artifactId),
        index = rows.findIndex((r) => r.operationId === record.operationId),
        current = rows[index];
      if (current && canonicalJson(current) === canonicalJson(record)) return;
      if ((current?.revision ?? null) !== expected || record.revision !== (expected ?? 0) + 1)
        throw Error('実行記録の保存が競合しました。');
      if (index < 0) rows.push(record);
      else rows[index] = record;
      if (rows.length > 256) throw Error('実行記録はArtifactあたり256件までです。');
      // No await between the current authorization/CAS and reference browser write.
      if (mayWrite() !== true) throw Error('実行記録の権限が変更されました。');
      storage.setItem(key(record.scope.artifactId), JSON.stringify(rows));
    },
  };
}
