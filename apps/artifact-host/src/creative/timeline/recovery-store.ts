/** Browser-side persistence of Timeline save receipts, serialized with Web Locks. */
import { canonicalJson, type Artifact, type StorageAdapter } from '@editor-platform/artifact-core';
import { readWorkspaceLinks, type CreativeWorkspaceLinksV2 } from '../workspace/model';
import { readTimelineSaveReceipt, type TimelineRecoveryStore } from './save-recovery';
export function browserTimelineRecoveryStore(
  key: string,
  artifacts: Pick<StorageAdapter<Artifact<unknown>>, 'get'>,
): TimelineRecoveryStore {
  const lock = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    if (!navigator.locks) throw Error('この環境は安全な保存復旧の排他制御に対応していません。');
    return await navigator.locks.request(key + ':' + name, work);
  };
  const readLinks = () => {
    const links = readWorkspaceLinks(JSON.parse(localStorage.getItem(key) ?? 'null'));
    if (links.schemaVersion !== 2) throw Error('対応表の版が違います。');
    return links;
  };
  const receipts = () => {
    const raw: unknown = JSON.parse(localStorage.getItem(key + ':save-receipts') ?? '[]');
    if (!Array.isArray(raw) || raw.length > 2000) throw Error('保存復旧記録の件数が不正です。');
    const values = raw.map(readTimelineSaveReceipt);
    if (new Set(values.map((r) => r.operationId)).size !== values.length)
      throw Error('保存復旧記録が重複しています。');
    return values;
  };
  return {
    artifacts,
    readLinks,
    receipts: async () => receipts(),
    exclusive: (owner, work) => lock('save:' + owner, work),
    writeLinks: (next: CreativeWorkspaceLinksV2, expected, validate) =>
      lock('links', async () => {
        if (canonicalJson(readLinks()) !== canonicalJson(expected))
          throw Error('原稿対応表の保存が競合しています。');
        validate();
        localStorage.setItem(key, JSON.stringify(readWorkspaceLinks(next)));
      }),
    writeReceipt: (next, expected) =>
      lock('receipts', async () => {
        const all = receipts(),
          current = all.find((r) => r.operationId === next.operationId) ?? null;
        if (canonicalJson(current) !== canonicalJson(expected))
          throw Error('保存復旧記録が変わりました。');
        const validated = readTimelineSaveReceipt(next);
        const rest = all.filter((r) => r.operationId !== next.operationId);
        if (rest.length >= 2000)
          throw Error('保存復旧記録の上限です。Hostで保持記録を整理してください。');
        localStorage.setItem(key + ':save-receipts', JSON.stringify([...rest, validated]));
      }),
  };
}
