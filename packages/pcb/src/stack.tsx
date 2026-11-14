import { useEffect, useState } from 'react';
import { CommitInput, Section } from '@editor-platform/editor-ui';
import type { PcbDocument, PcbStackedBoard, PcbStackedSource } from '@editor-platform/pcb-core';
import type { PcbController, PcbState } from './controller';

/**
 * PB8: where stacked boards come from: the Host's saved versions of other boards. The board
 * names an exact version (as a building names a CAD part's) and asks the Host for its content;
 * the pcb package never reads another Artifact itself.
 */
export interface PcbBoardVersion {
  versionId: string;
  label: string;
  contentHash: string;
}
export interface PcbBoardCandidate {
  artifactId: string;
  name: string;
  /** Newest first. */
  versions: PcbBoardVersion[];
}
export interface PcbBoardSource {
  /** The other boards with saved versions. */
  list(): Promise<PcbBoardCandidate[]>;
  /** The exact version's board. Rejects with an Error whose message is a code. */
  document(source: PcbStackedBoard['source']): Promise<PcbDocument>;
}

/** The standard spacing of a board on the 40-pin header with a 2×20 socket, mm. */
export const pcbHeaderGapMm = 11;

/** One read of the stacked boards: for which stack (`key`) and from which source. */
export interface PcbStackedRead {
  key: string;
  source: PcbBoardSource | undefined;
  boards: PcbStackedSource[];
}

/** The boards of `read` when it is for this stack and this source, else undefined (reading). */
export function pcbCurrentStacked(
  read: PcbStackedRead | undefined,
  key: string,
  source: PcbBoardSource | undefined,
): PcbStackedSource[] | undefined {
  return read?.key === key && read.source === source ? read.boards : undefined;
}

/**
 * The stacked boards of `doc`, read from `source` (each kept until its entry or the source
 * changes). Undefined while the boards for the current stack and source are being read, so a
 * result read from another source (such as none, while the 3D view was closed) is never shown.
 */
export function useStackedBoards(
  doc: PcbDocument,
  source: PcbBoardSource | undefined,
): PcbStackedSource[] | undefined {
  const [read, setRead] = useState<PcbStackedRead>();
  const key = JSON.stringify(doc.stack);
  useEffect(() => {
    if (!doc.stack.length) return setRead({ key, source, boards: [] });
    let live = true;
    void Promise.all(
      doc.stack.map(async (entry): Promise<PcbStackedSource> => {
        if (!source) return { entry, error: 'board-source-unavailable' };
        try {
          return { entry, doc: await source.document(entry.source) };
        } catch (e) {
          return { entry, error: e instanceof Error ? e.message : 'board-source-missing' };
        }
      }),
    ).then((boards) => live && setRead({ key, source, boards }));
    return () => {
      live = false;
    };
    // `key` stands for the stack's content.
  }, [key, source]);
  return pcbCurrentStacked(read, key, source);
}

const num = (s: string) => Number(s);

/** The board inspector's list of boards above this one, and adding one from the Host. */
export function StackPanel({
  controller,
  state,
  source,
}: {
  controller: PcbController;
  state: PcbState;
  source: PcbBoardSource | undefined;
}) {
  const [candidates, setCandidates] = useState<PcbBoardCandidate[]>();
  const [choice, setChoice] = useState('');
  const readOnly = state.readOnly;
  useEffect(() => {
    let live = true;
    void source?.list().then((c) => live && setCandidates(c));
    return () => {
      live = false;
    };
  }, [source, state.content.stack.length]);
  const options = (candidates ?? []).flatMap((c) =>
    c.versions.map((v) => ({ key: `${c.artifactId}\u0000${v.versionId}`, c, v })),
  );
  const add = () => {
    const o = options.find((x) => x.key === choice) ?? options[0];
    if (!o) return;
    controller.addStacked({
      name: o.c.name,
      source: {
        artifactId: o.c.artifactId,
        versionId: o.v.versionId,
        contentHash: o.v.contentHash,
      },
      at: [0, 0],
      rotationDeg: 0,
      gapMm: pcbHeaderGapMm,
    });
  };
  return (
    <Section title="Boards above">
      {state.content.stack.length === 0 && (
        <p className="pcb-empty">No board above this one (shown in 3D only).</p>
      )}
      <ul className="pcb-list" aria-label="Boards above" data-testid="pcb-stack">
        {state.content.stack.map((b) => (
          <li key={b.id}>
            <strong>{b.name}</strong>
            <CommitInput
              label={`${b.name} gap (mm)`}
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={b.gapMm}
              onCommit={(v) => !controller.updateStacked({ ...b, gapMm: num(v) })}
            />
            <CommitInput
              label={`${b.name} x (mm)`}
              type="number"
              step={0.1}
              value={b.at[0]}
              onCommit={(v) => !controller.updateStacked({ ...b, at: [num(v), b.at[1]] })}
            />
            <CommitInput
              label={`${b.name} y (mm)`}
              type="number"
              step={0.1}
              value={b.at[1]}
              onCommit={(v) => !controller.updateStacked({ ...b, at: [b.at[0], num(v)] })}
            />
            <CommitInput
              label={`${b.name} rotation (°)`}
              type="number"
              min={0}
              max={359}
              step={90}
              value={b.rotationDeg}
              onCommit={(v) => !controller.updateStacked({ ...b, rotationDeg: num(v) })}
            />
            {!readOnly && (
              <button type="button" onClick={() => controller.removeStacked(b.id)}>
                Remove {b.name}
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && source && (
        <div className="pcb-stack-add">
          <label>
            Board version
            <select
              aria-label="Board version to stack"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              disabled={!options.length}
            >
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.c.name} {o.v.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!options.length} onClick={add}>
            Add board above
          </button>
          {candidates && !options.length && (
            <p className="pcb-empty">Save a version of another board to stack it here.</p>
          )}
        </div>
      )}
    </Section>
  );
}
