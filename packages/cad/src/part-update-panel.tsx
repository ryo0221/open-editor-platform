/**
 * R2b-2b Surface entry (docs/cad/r2b-assembly.md, Surface・版の更新): choosing other saved
 * versions for parts, the preview of what changes (sizes, volumes, the components that move, the
 * joints that break), and adopting it as one edit, or choosing broken connectors again with it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CadPartDef } from '@editor-platform/cad-core';
import { Dialog } from '@editor-platform/editor-ui';
import type { CadAssembly, CadPartCandidate, CadVersionSummary } from './assembly';
import { describeCode } from './controller';

const size = (s: CadVersionSummary | undefined) =>
  s ? s.sizeMm.map((v) => +v.toFixed(2)).join(' × ') + ' mm' : '—';
const volume = (s: CadVersionSummary | undefined) =>
  s?.volumeMm3 === undefined ? '—' : `${+s.volumeMm3.toFixed(1)} mm³`;

export function UpdatePartsDialog({
  assembly,
  partIds,
  content,
  onClose,
}: {
  assembly: CadAssembly;
  partIds: string[];
  content: { parts: readonly CadPartDef[] };
  onClose: () => void;
}) {
  const { update } = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const [list, setList] = useState<CadPartCandidate[] | 'loading' | 'failed'>('loading');
  // A part imported into this document has no other versions.
  const parts = partIds.flatMap((id) =>
    content.parts.flatMap((p) =>
      p.id === id && p.source.kind === 'version' ? [{ ...p, source: p.source }] : [],
    ),
  );
  // Each part's chosen version: the newest by default.
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      parts.flatMap((p) => {
        const newer = assembly.newerVersion(p.id);
        return newer ? [[p.id, newer.versionId]] : [];
      }),
    ),
  );
  useEffect(() => {
    let live = true;
    assembly.source
      ?.list()
      .then((l) => live && setList(l))
      .catch(() => live && setList('failed'));
    return () => {
      live = false;
    };
  }, [assembly]);
  const versions = (artifactId: string) =>
    typeof list === 'object' ? (list.find((c) => c.artifactId === artifactId)?.versions ?? []) : [];
  const targets = parts.flatMap((p) => {
    const versionId = chosen[p.id];
    if (!versionId || versionId === p.source.versionId) return [];
    const label = versions(p.source.artifactId).find((v) => v.versionId === versionId)?.label;
    return [{ partId: p.id, versionId, ...(label ? { label } : {}) }];
  });
  const close = () => {
    if (update) assembly.cancelUpdate();
    onClose();
  };
  return (
    <Dialog title="Update part version" onClose={close}>
      <div className="cad-export" data-testid="cad-update-parts">
        {!update && (
          <>
            <p>
              選んだ版を部品に使います。jointの接続点は新しい版の上で解決し直し、採用は1つの編集です。
            </p>
            {list === 'loading' && <p role="status">読み込んでいます…</p>}
            {list === 'failed' && <p role="alert">部品の版の一覧を読み込めませんでした。</p>}
            <ul className="cad-part-candidates" aria-label="Parts to update">
              {parts.map((p) => (
                <li key={p.id}>
                  <span>
                    {p.name} · version {p.source.versionId}
                  </span>
                  <select
                    aria-label={`New version of ${p.name}`}
                    value={chosen[p.id] ?? ''}
                    onChange={(e) => setChosen({ ...chosen, [p.id]: e.target.value })}
                  >
                    <option value="">Keep this version</option>
                    {versions(p.source.artifactId)
                      .filter((v) => v.versionId !== p.source.versionId)
                      .map((v) => (
                        <option key={v.versionId} value={v.versionId}>
                          {v.label}
                        </option>
                      ))}
                  </select>
                </li>
              ))}
            </ul>
            <div className="cad-row">
              <button
                type="button"
                disabled={!targets.length}
                onClick={() => void assembly.prepareUpdate(targets)}
              >
                Preview
              </button>
              <button type="button" onClick={close}>
                Cancel
              </button>
            </div>
          </>
        )}
        {update?.status === 'preparing' && <p role="status">新しい版を計算しています…</p>}
        {update && update.status !== 'preparing' && (
          <>
            <table className="cad-update-table" aria-label="Changes">
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Version</th>
                  <th>Size</th>
                  <th>Volume</th>
                </tr>
              </thead>
              <tbody>
                {update.parts.map((p) => (
                  <tr key={p.partId}>
                    <td>{p.name}</td>
                    <td>
                      {p.from} → {p.to}
                    </td>
                    <td>
                      {size(p.fromSummary)} → {size(p.toSummary)}
                    </td>
                    <td>
                      {volume(p.fromSummary)} → {volume(p.toSummary)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {update.status === 'ready' && (
              <p role="status" data-testid="cad-update-moved">
                {update.moved.length
                  ? `動く部品：${update.moved.join('、')}`
                  : '配置の変わる部品はありません。'}
              </p>
            )}
            {update.status === 'broken' && (
              <div role="alert" data-testid="cad-update-broken">
                <p>
                  この更新で次のjointの接続点が解決できなくなります：
                  {update.broken.map((b) => b.name).join('、')}
                </p>
                {update.code && <p>{describeCode(update.code)}</p>}
                {!update.canChoose && (
                  <p>選べる候補がありません。先にそのjointを削除するか、別の版を選んでください。</p>
                )}
              </div>
            )}
            <div className="cad-row">
              {update.status === 'ready' && (
                <button
                  type="button"
                  onClick={() => {
                    if (assembly.applyUpdate()) onClose();
                  }}
                >
                  Apply update
                </button>
              )}
              {update.status === 'broken' && update.canChoose && (
                <button
                  type="button"
                  onClick={() => {
                    if (assembly.chooseUpdate()) onClose();
                  }}
                >
                  Choose connectors again…
                </button>
              )}
              <button type="button" onClick={close}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
