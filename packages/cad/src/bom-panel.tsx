/**
 * R2b-3 Surface entries (docs/cad/r2b-assembly.md, Surface・BOM): the bill of materials (flat or
 * hierarchical) with its CSV export, and this document's own part number and description, which
 * an assembly placing one of its versions reads.
 */
import { useState } from 'react';
import { CommitInput, Dialog, Section } from '@editor-platform/editor-ui';
import type { CadBomMode } from '@editor-platform/cad-core';
import type { CadAssembly } from './assembly';
import type { CadController, CadSnapshot } from './controller';

export function BomDialog({
  assembly,
  name,
  onExportCsv,
  onClose,
}: {
  assembly: CadAssembly;
  name: string;
  onExportCsv?: (csv: Blob, options: { fileName: string }) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<CadBomMode>('flat');
  const rows = assembly.bom(mode);
  function exportCsv() {
    const fileName = `${name}-bom${mode === 'flat' ? '' : '-hierarchical'}.csv`;
    const csv = new Blob([assembly.bomCsv(mode)], { type: 'text/csv;charset=utf-8' });
    if (onExportCsv) return onExportCsv(csv, { fileName });
    const url = URL.createObjectURL(csv);
    Object.assign(document.createElement('a'), { href: url, download: fileName }).click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return (
    <Dialog title="Bill of materials" onClose={onClose}>
      <div className="cad-bom" data-testid="cad-bom">
        <fieldset className="cad-row">
          <legend>Table</legend>
          {(['flat', 'hierarchical'] as const).map((m) => (
            <label key={m}>
              <input
                type="radio"
                name="cad-bom-mode"
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              {m === 'flat' ? 'Flat' : 'Hierarchical'}
            </label>
          ))}
        </fieldset>
        <div className="cad-bom-scroll">
          <table className="cad-migration" aria-label="Bill of materials">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Part number</th>
                <th scope="col">Name</th>
                <th scope="col">Description</th>
                <th scope="col">Qty</th>
                <th scope="col">Version</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.item}`} data-kind={r.kind}>
                  <td>{r.item}</td>
                  <td>
                    {r.partNumber ||
                      (r.kind !== 'body' && <small className="cad-muted">（未入力）</small>)}
                  </td>
                  <td style={{ paddingInlineStart: `${8 + r.level * 16}px` }}>
                    {r.name}
                    {r.kind === 'body' && <small className="cad-muted"> (this document)</small>}
                    {r.unavailable && <small className="cad-muted"> (読めません)</small>}
                  </td>
                  <td>{r.description}</td>
                  <td>{r.quantity}</td>
                  <td
                    title={
                      r.reference
                        ? `${r.reference.artifactId} · ${r.reference.versionId}`
                        : undefined
                    }
                  >
                    {r.reference
                      ? assembly.versionLabel(r.reference.artifactId, r.reference.versionId)
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.some((r) => r.unavailable) && (
          <p className="cad-muted">読めない部品は名前だけを示し、その中の部品は数えていません。</p>
        )}
        <div className="cad-row">
          <button type="button" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** This document's BOM values, read by an assembly that places one of its saved versions. */
export function PartPropertiesSection({
  controller,
  snapshot,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
}) {
  const { partNumber, description } = snapshot.content.partProperties;
  const set = (next: { partNumber: string; description: string }) =>
    void controller.run({ type: 'setPartProperties', ...next });
  return (
    <Section title="Part properties" open={false}>
      <fieldset
        className="cad-part-properties"
        disabled={snapshot.readOnly || snapshot.busy}
        key={snapshot.rejections}
      >
        <CommitInput
          label="Part number"
          value={partNumber}
          onCommit={(v) => set({ partNumber: v, description })}
        />
        <CommitInput
          label="Description"
          value={description}
          onCommit={(v) => set({ partNumber, description: v })}
        />
      </fieldset>
    </Section>
  );
}
