import { useRef, useState } from 'react';
import { contentHash } from '@editor-platform/artifact-core';
import {
  geoEditorCommand,
  createPinnedGeoJoinBetween,
  emptyGeoWorkspace,
  type GeoDocument,
  type PinnedGeoJoin,
} from '@editor-platform/geo-core';
import { isStructuredData } from '@editor-platform/structured-data/model';
import type { ReferenceSnapshot } from '@editor-platform/artifact-references';
import { projectData } from './resources';
import { sourceBudgets } from './geo-source-envelope';
import type { GeoSurfaceProps } from './surface';
/** Discovery reads committed versions only; preview never writes and refresh requires adoption. */
export function DataJoinTools(props: GeoSurfaceProps) {
  const [source, setSource] = useState(''),
    [layerId, setLayer] = useState(''),
    [leftKey, setLeftKey] = useState(''),
    [rightKey, setRightKey] = useState(''),
    [message, setMessage] = useState(''),
    [candidate, setCandidate] = useState<{
      join: PinnedGeoJoin;
      input: ReferenceSnapshot;
      revision: string;
      leftKey: string;
      rightKey: string;
      source: string;
      layerId: string;
    }>();
  const generation = useRef(0),
    latest = useRef(props);
  latest.current = props;
  const sources = props.records.filter((r) => r.kind === 'data' && r.versions.length),
    data = sources.find((r) => r.id === source)?.versions.at(-1)?.content;
  const content = props.artifact.draft.content as GeoDocument,
    layer = content.layers.find((l) => l.id === layerId);
  const invalidate = () => {
    generation.current++;
    setCandidate(undefined);
  };
  const clean = () => {
    const p = latest.current.inputs.getSnapshot();
    if (latest.current.readOnly || p.dirty || p.composing)
      throw Error('Apply or Cancel pending input first');
  };
  async function preview() {
    invalidate();
    const ticket = generation.current;
    try {
      clean();
      const record = structuredClone(props.saved()),
        left = record.versions.at(-1),
        rightRecord = sources.find((r) => r.id === source),
        right = rightRecord?.versions.at(-1),
        revision = JSON.stringify(props.session.revision);
      if (!left || !right || !rightRecord || !isStructuredData(right.content))
        throw Error('Save Geo and Data versions first');
      if ((await contentHash(props.session.content)) !== left.contentHash)
        throw Error('Save the current Geo version before joining');
      if (
        (await contentHash(left.content)) !== left.contentHash ||
        (await contentHash(right.content)) !== right.contentHash
      )
        throw Error('Input hash mismatch');
      const input: ReferenceSnapshot = {
        artifactId: rightRecord.id,
        domain: 'data',
        versionId: right.versionId,
        revision: rightRecord.versions.length,
        contentHash: right.contentHash,
        content: structuredClone(right.content),
        dependencies: [],
      };
      const join = createPinnedGeoJoinBetween(
        {
          content: left.content as GeoDocument,
          pin: {
            artifactId: record.id,
            versionId: left.versionId,
            contentHash: 'sha256:' + left.contentHash,
          },
        },
        {
          content: projectData(right.content),
          pin: {
            artifactId: rightRecord.id,
            versionId: right.versionId,
            contentHash: 'sha256:' + right.contentHash,
          },
        },
        {
          id: 'data-values',
          layerId,
          tableLayerId: 'data',
          leftFieldId: leftKey,
          rightFieldId: rightKey,
          cardinality: 'many-to-one',
        },
        sourceBudgets,
      );
      clean();
      if (ticket !== generation.current || revision !== JSON.stringify(props.session.revision))
        throw Error('Join preview changed');
      setCandidate({ join, input, revision, leftKey, rightKey, source, layerId });
      setMessage(
        `Preview: ${join.rows.filter((r) => r.status === 'matched').length} matched; ${join.rows.filter((r) => r.status === 'unmatched').length} unmatched; ${join.rows.filter((r) => r.status === 'null-key').length} null keys. Data ${right.versionId}. Review before adopting.`,
      );
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    }
  }
  function adopt() {
    try {
      clean();
      if (
        !candidate ||
        candidate.revision !== JSON.stringify(props.session.revision) ||
        candidate.source !== source ||
        candidate.layerId !== layerId ||
        candidate.leftKey !== leftKey ||
        candidate.rightKey !== rightKey
      )
        throw Error('Preview is stale');
      const w = structuredClone(content.workspace ?? emptyGeoWorkspace());
      w.joins = [...w.joins.filter((j) => j.id !== candidate.join.id), candidate.join];
      const inputs = [
        ...(props.artifact.geoDataInputs ?? []).filter(
          (s) =>
            s.artifactId !== candidate.input.artifactId ||
            s.versionId !== candidate.input.versionId,
        ),
        candidate.input,
      ];
      if (inputs.length > 16) throw Error('Data dependency budget (16 retained inputs)');
      const command = geoEditorCommand(
        {
          expectedRevision: props.session.revision,
          actions: [{ type: 'setWorkspace', workspace: w }],
        },
        () => ({
          revision: props.session.revision,
          canEdit: !latest.current.readOnly,
          budgets: sourceBudgets,
        }),
      );
      if (!props.execute(command, undefined, inputs)) throw Error('Join adoption refused');
      setCandidate(undefined);
      setMessage(
        'Pinned Data values adopted. Save Geo to publish this map version. Following Slide references update only after that save.',
      );
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    }
  }
  const currentJoin = content.workspace?.joins.find((j) => j.id === 'data-values'),
    latestSource =
      currentJoin &&
      sources.find((r) => r.id === currentJoin.inputs.right.artifactId)?.versions.at(-1);
  const available = latestSource && latestSource.versionId !== currentJoin?.inputs.right.versionId;
  return (
    <section aria-label="Join existing Data artifact">
      <h2>Data 表との結合</h2>
      <p>
        保存済みの Data 版を固定して結合します。Data
        の変更は自動採用しません。キーの型と先頭ゼロを保ち、重複キーは拒否します。
      </p>
      {available && (
        <p role="status">新しい Data 版があります。プレビューして明示的に採用してください。</p>
      )}
      <label>
        Saved Data artifact
        <select
          aria-label="Saved Data artifact"
          value={source}
          onChange={(e) => {
            invalidate();
            setSource(e.target.value);
            setRightKey('');
          }}
        >
          <option value="">Choose Data</option>
          {sources.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Geo join layer
        <select
          aria-label="Geo join layer"
          value={layerId}
          onChange={(e) => {
            invalidate();
            setLayer(e.target.value);
            setLeftKey('');
          }}
        >
          <option value="">Choose layer</option>
          {content.layers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Geo key
        <select
          aria-label="Geo key"
          value={leftKey}
          onChange={(e) => {
            invalidate();
            setLeftKey(e.target.value);
          }}
        >
          <option value="">Choose key</option>
          {layer?.fields
            .filter((f) => f.type !== 'boolean')
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.type})
              </option>
            ))}
        </select>
      </label>
      <label>
        Data key
        <select
          aria-label="Data key"
          value={rightKey}
          onChange={(e) => {
            invalidate();
            setRightKey(e.target.value);
          }}
        >
          <option value="">Choose key</option>
          {isStructuredData(data) &&
            data.columns
              .filter((c) => c.type === 'text' || c.type === 'number')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.type})
                </option>
              ))}
        </select>
      </label>
      <button disabled={props.readOnly} onClick={() => void preview()}>
        Preview Data join / refresh
      </button>
      <button disabled={props.readOnly || !candidate} onClick={adopt}>
        Adopt previewed Data version
      </button>
      <p role="status" aria-label="Data join status">
        {message}
      </p>
    </section>
  );
}
