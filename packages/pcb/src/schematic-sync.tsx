import { useContext, useEffect, useMemo, useState } from 'react';
import { EditorInputsContext, Section } from '@editor-platform/editor-ui';
import {
  SchematicBoardError,
  schematicBoardDiff,
  schematicBoardOperations,
  type SchematicBoardChange,
  type SchematicDocument,
} from '@editor-platform/schematic-core';
import type { PcbController, PcbState } from './controller';

/**
 * SL3b: the board takes a schematic's parts and nets (docs/cad/circuit-simulation.md, SL3,
 * SL-U5). The Host lists its schematics' saved versions and reads one exact version; the pcb
 * package never reads another Artifact itself. The diff is against the board as it is now, and
 * the changes kept apply as one edit (one Undo). The board never writes back to the schematic.
 */
export interface PcbSchematicVersion {
  versionId: string;
  label: string;
  contentHash: string;
}
export interface PcbSchematicCandidate {
  artifactId: string;
  name: string;
  /** Newest first. */
  versions: PcbSchematicVersion[];
}
export interface PcbSchematicRef {
  artifactId: string;
  versionId: string;
  contentHash: string;
}
export interface PcbSchematicSource {
  /** The schematics with saved versions. */
  list(): Promise<PcbSchematicCandidate[]>;
  /** The exact version's schematic. Rejects with an Error whose message is a code. */
  document(ref: PcbSchematicRef): Promise<SchematicDocument>;
}

const kindText: Record<SchematicBoardChange['kind'], string> = {
  'add-part': 'Add part',
  value: 'Value',
  footprint: 'Footprint',
  'board-only-part': 'Delete part (board only)',
  'add-net': 'Add net',
  'net-pins': 'Net pins',
  'rename-net': 'Rename net',
  'board-only-net': 'Delete net (board only)',
};
/** One line of a change: what it is and what it does. */
export function pcbSchematicChangeText(c: SchematicBoardChange): string {
  const parts = [`${kindText[c.kind]} ${c.name}`];
  if (c.from !== undefined && c.to !== undefined) parts.push(`${c.from} → ${c.to}`);
  else if (c.to !== undefined) parts.push(c.to);
  if (c.add?.length) parts.push(`+${c.add.join(', ')}`);
  if (c.remove?.length) parts.push(`−${c.remove.join(', ')}`);
  return parts.join(' · ');
}

/** The board inspector's "From schematic": pick a version, see the diff, apply what is kept. */
export function SchematicSyncPanel({
  controller,
  state,
  source,
}: {
  controller: PcbController;
  state: PcbState;
  source: PcbSchematicSource;
}) {
  const inputs = useContext(EditorInputsContext);
  const [candidates, setCandidates] = useState<PcbSchematicCandidate[]>();
  const [choice, setChoice] = useState('');
  const [read, setRead] = useState<{ key: string; doc?: SchematicDocument; error?: string }>();
  const [chosen, setChosen] = useState<{ key: string; ids: Set<string> }>();
  useEffect(() => {
    let live = true;
    void source.list().then((c) => live && setCandidates(c));
    return () => {
      live = false;
    };
    // Read again as the board changes, so versions saved meanwhile show up.
  }, [source, state.hash]);
  const options = (candidates ?? []).flatMap((c) =>
    c.versions.map((v) => ({ key: `${c.artifactId}\u0000${v.versionId}`, c, v })),
  );
  const option = options.find((o) => o.key === choice) ?? options[0];
  const key = option?.key ?? '';
  // Reads the chosen version (an exact one: its content hash is checked by the Host).
  useEffect(() => {
    if (!option) return;
    let live = true;
    source
      .document({
        artifactId: option.c.artifactId,
        versionId: option.v.versionId,
        contentHash: option.v.contentHash,
      })
      .then(
        (doc) => live && setRead({ key: option.key, doc }),
        (e: unknown) =>
          live && setRead({ key: option.key, error: e instanceof Error ? e.message : 'failed' }),
      );
    return () => {
      live = false;
    };
    // `key` names the version.
  }, [source, key]);
  const current = read?.key === key ? read : undefined;
  const diff = useMemo(
    () => (current?.doc ? schematicBoardDiff(current.doc, state.content) : undefined),
    [current?.doc, state.content],
  );
  // The selection starts as the diff suggests and is kept per diff (a new board or version
  // starts over).
  const diffKey = `${key}\u0000${state.hash}`;
  const selected =
    chosen?.key === diffKey
      ? chosen.ids
      : new Set(diff?.changes.filter((c) => c.selected && c.applicable).map((c) => c.id));
  const toggle = (id: string, on: boolean) => {
    const ids = new Set(selected);
    if (on) ids.add(id);
    else ids.delete(id);
    setChosen({ key: diffKey, ids });
  };
  const apply = () => {
    try {
      inputs?.flush();
    } catch {
      return;
    }
    if (!current?.doc) return;
    let ops;
    try {
      ops = schematicBoardOperations(current.doc, state.content, selected, (taken) => {
        for (let k = 1; ; k++) if (!taken.has(`sch-${k}`)) return `sch-${k}`;
      });
    } catch (e) {
      controller.report({
        code: e instanceof SchematicBoardError ? e.code : 'failed',
        ids: [],
      });
      return;
    }
    controller.applyBatch(ops, 'Update from schematic');
  };
  const readOnly = state.readOnly;
  return (
    <Section title="From schematic">
      {candidates && !options.length && (
        <p className="pcb-empty">Save a version of a schematic to send it to this board.</p>
      )}
      {options.length > 0 && (
        <label className="pcb-pick">
          Schematic version
          <select
            aria-label="Schematic version"
            value={key}
            onChange={(e) => setChoice(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.c.name} {o.v.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {current?.error && (
        <p className="pcb-empty" role="alert">
          The schematic could not be read ({current.error}).
        </p>
      )}
      {diff &&
        diff.changes.length === 0 &&
        diff.conflicts.length === 0 &&
        diff.duplicateNames.length === 0 && (
          <p className="pcb-empty" data-testid="pcb-schematic-clean">
            The board matches the schematic.
          </p>
        )}
      {diff && diff.conflicts.length > 0 && (
        <ul className="pcb-list" aria-label="Pad conflicts" data-testid="pcb-schematic-conflicts">
          {diff.conflicts.map((c) => (
            <li key={c.pad} className="pcb-error">
              {c.pad} is on {c.nets.join(' and ')}: fix the schematic first.
            </li>
          ))}
        </ul>
      )}
      {diff && diff.duplicateNames.length > 0 && (
        <ul className="pcb-list" aria-label="Shared net names" data-testid="pcb-schematic-names">
          {diff.duplicateNames.map((n) => (
            <li key={n} className="pcb-error">
              Two schematic nets are named {n}: fix the schematic first.
            </li>
          ))}
        </ul>
      )}
      {diff && diff.changes.length > 0 && (
        <ul className="pcb-list" aria-label="Schematic changes" data-testid="pcb-schematic-changes">
          {diff.changes.map((c) => (
            <li key={c.id} data-kind={c.kind}>
              <label className="pcb-check">
                <input
                  type="checkbox"
                  aria-label={pcbSchematicChangeText(c)}
                  checked={selected.has(c.id)}
                  disabled={readOnly || !c.applicable}
                  onChange={(e) => toggle(c.id, e.target.checked)}
                />
                {pcbSchematicChangeText(c)}
                {!c.applicable && ' (copper uses it)'}
              </label>
            </li>
          ))}
        </ul>
      )}
      {diff && diff.skipped.length > 0 && (
        <p className="pcb-empty" data-testid="pcb-schematic-skipped">
          Not sent:{' '}
          {diff.skipped
            .map((k) => `${k.ref} (${k.reason === 'no-footprint' ? 'no footprint' : 'no pin map'})`)
            .join(', ')}
          .
        </p>
      )}
      {diff && diff.changes.length > 0 && !readOnly && (
        <div className="pcb-actions">
          <button
            type="button"
            disabled={
              selected.size === 0 || diff.conflicts.length > 0 || diff.duplicateNames.length > 0
            }
            onClick={apply}
          >
            Apply {selected.size} change{selected.size === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </Section>
  );
}
