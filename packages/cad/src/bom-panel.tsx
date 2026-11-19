/**
 * R2b-3 Surface entries (docs/cad/r2b-assembly.md, Surface・BOM): the bill of materials (flat or
 * hierarchical) with its CSV export, and this document's own part number and description, which
 * an assembly placing one of its versions reads. PD2 (docs/cad/product-design.md): each row's
 * material, sourcing class, mass and cost, the totals (by sourcing class too) with what they leave
 * out, a JSON export, and this document's material, sourcing, unit cost, currency and supplier.
 */
import { useState, useSyncExternalStore } from 'react';
import { CommitInput, Dialog, Section } from '@editor-platform/editor-ui';
import {
  cadMassLimits,
  cadMassMaterials,
  cadPartBomKeys,
  cadPartCostLimits,
  cadPartSourcings,
  type CadBomLeftOut,
  type CadBomMode,
  type CadPartBomValues,
  type CadPartSourcing,
} from '@editor-platform/cad-core';
import type { CadAssembly } from './assembly';
import type { CadController, CadSnapshot } from './controller';
import { fmtGrouped } from './dimension-fields';

/** PD2: the sourcing classes as the panels name them. */
export const sourcingText: Record<CadPartSourcing | 'unset', string> = {
  make: 'Make',
  outsource: 'Outsource',
  buy: 'Buy',
  standard: 'Standard',
  unset: 'Not set',
};
const leftOutText: Record<CadBomLeftOut['code'], string> = {
  'mass-missing': 'no density or material',
  'mass-thickness-missing': 'sheet without a thickness',
  'mass-not-evaluated': 'not calculated yet',
  'mass-no-access': 'no read access',
  'mass-part-missing': 'version not available',
  'mass-part-failed': 'version could not be calculated',
  'mass-part-unavailable': 'version not calculated with this build',
  'cost-missing': 'no unit cost',
  'cost-currency': 'unit cost in another currency',
  'cost-unavailable': 'cost unknown (version not readable)',
};
const money = (v: number | undefined, currency: string | undefined) =>
  v === undefined ? '' : `${fmtGrouped(v, 2)}${currency ? ` ${currency}` : ''}`;
const kg = (v: number | undefined) => (v === undefined ? '' : `${fmtGrouped(v, 3)} kg`);

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
  // The mass follows the part versions as they finish evaluating.
  useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const report = assembly.bomReport(mode);
  const { rows, totals } = report;
  function save(file: Blob, fileName: string) {
    if (onExportCsv) return onExportCsv(file, { fileName });
    const url = URL.createObjectURL(file);
    Object.assign(document.createElement('a'), { href: url, download: fileName }).click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const stem = `${name}-bom${mode === 'flat' ? '' : '-hierarchical'}`;
  const exportCsv = () =>
    save(new Blob([assembly.bomCsv(mode)], { type: 'text/csv;charset=utf-8' }), `${stem}.csv`);
  // PD2: the JSON export (the same report, with the totals and what they leave out).
  const exportJson = () =>
    save(new Blob([assembly.bomJson(mode, name)], { type: 'application/json' }), `${stem}.json`);
  const cur = totals.currency;
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
                <th scope="col">Material</th>
                <th scope="col">Sourcing</th>
                <th scope="col">Supplier</th>
                <th scope="col">Mass</th>
                <th scope="col">Unit cost</th>
                <th scope="col">Cost</th>
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
                  <td>{r.material ?? ''}</td>
                  <td>{r.sourcing ? sourcingText[r.sourcing] : ''}</td>
                  <td>{r.supplier ?? ''}</td>
                  <td title={r.unitMassKg !== undefined ? `${kg(r.unitMassKg)} each` : undefined}>
                    {kg(r.massKg)}
                    {r.massLeftOut ? (
                      <small className="cad-muted">
                        {r.massKg === undefined ? '数えていません' : ' (一部)'}
                      </small>
                    ) : null}
                  </td>
                  <td>{money(r.unitCost, r.currency)}</td>
                  <td>{money(r.cost, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="cad-metrics" data-testid="cad-bom-totals">
          <dt>Total mass</dt>
          <dd data-testid="cad-bom-mass">{kg(totals.massKg)}</dd>
          <dt>Total cost</dt>
          <dd data-testid="cad-bom-cost">{money(totals.cost, cur) || '0'}</dd>
        </dl>
        <table className="cad-migration" aria-label="Parts by sourcing">
          <thead>
            <tr>
              <th scope="col">Sourcing</th>
              <th scope="col">Qty</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {([...cadPartSourcings, 'unset'] as const)
              .filter((k) => totals.bySourcing[k].quantity > 0)
              .map((k) => (
                <tr key={k}>
                  <td>{sourcingText[k]}</td>
                  <td>{totals.bySourcing[k].quantity}</td>
                  <td>{money(totals.bySourcing[k].cost, cur)}</td>
                </tr>
              ))}
          </tbody>
        </table>
        {totals.leftOut.length > 0 && (
          <details data-testid="cad-bom-left-out">
            <summary>Not counted: {totals.leftOut.length}</summary>
            <ul>
              {totals.leftOut.map((l, i) => (
                <li key={i}>
                  {[l.item, l.name || name, l.bodyName].filter(Boolean).join(' · ')}:{' '}
                  {leftOutText[l.code]}
                </li>
              ))}
            </ul>
          </details>
        )}
        {rows.some((r) => r.unavailable) && (
          <p className="cad-muted">読めない部品は名前だけを示し、その中の部品は数えていません。</p>
        )}
        <div className="cad-row">
          <button type="button" onClick={exportCsv}>
            Export CSV
          </button>
          <button type="button" onClick={exportJson}>
            Export JSON
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
  const props = snapshot.content.partProperties;
  const { partNumber, description } = props;
  const set = (next: { partNumber: string; description: string }) =>
    void controller.run({ type: 'setPartProperties', ...next });
  // PD2: the other values are replaced together; an absent one is cleared.
  const setValues = (patch: CadPartBomValues) => {
    const next: CadPartBomValues = {};
    for (const k of cadPartBomKeys) {
      const v = Object.hasOwn(patch, k) ? patch[k] : props[k];
      if (v !== undefined) Object.assign(next, { [k]: v });
    }
    void controller.run({ type: 'setPartBomProperties', ...next });
  };
  const [lo, hi] = cadMassLimits.densityKgM3;
  const [clo, chi] = cadPartCostLimits.unitCost;
  const material = props.material;
  const preset = material
    ? cadMassMaterials[material.name] === material.densityKgM3
      ? material.name
      : 'custom'
    : '';
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
        <label className="ep-field">
          Material
          <select
            value={preset}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return setValues({ material: undefined });
              const density = cadMassMaterials[id];
              if (density !== undefined)
                setValues({ material: { name: id, densityKgM3: density } });
            }}
          >
            <option value="">None</option>
            {preset === 'custom' && <option value="custom">{material!.name}</option>}
            {Object.keys(cadMassMaterials).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <CommitInput
          label="Material name"
          value={material?.name ?? ''}
          onCommit={(v) => {
            const name = v.trim();
            if (!name) return setValues({ material: undefined });
            const density = material?.densityKgM3 ?? cadMassMaterials[name];
            if (density === undefined) return false;
            setValues({ material: { name, densityKgM3: density } });
          }}
        />
        <CommitInput
          label="Material density (kg/m³)"
          type="number"
          min={lo}
          max={hi}
          value={material?.densityKgM3 ?? ''}
          onCommit={(v) => {
            const d = Number(v);
            if (!v.trim() || !(d >= lo && d <= hi)) return false;
            // A density by hand without a material yet names it "Custom" (rename it after).
            setValues({ material: { name: material?.name ?? 'Custom', densityKgM3: d } });
          }}
        />
        <label className="ep-field">
          Sourcing
          <select
            value={props.sourcing ?? ''}
            onChange={(e) =>
              setValues({
                sourcing: (e.target.value || undefined) as CadPartSourcing | undefined,
              })
            }
          >
            <option value="">{sourcingText.unset}</option>
            {cadPartSourcings.map((k) => (
              <option key={k} value={k}>
                {sourcingText[k]}
              </option>
            ))}
          </select>
        </label>
        <CommitInput
          label="Currency"
          value={props.currency ?? ''}
          placeholder="JPY"
          onCommit={(v) => {
            const c = v.trim().toUpperCase();
            if (!c)
              return props.unitCost === undefined ? setValues({ currency: undefined }) : false;
            if (!cadPartCostLimits.currency.test(c)) return false;
            setValues({ currency: c });
          }}
        />
        <CommitInput
          // Text, not a number field: emptying it clears the cost (a number field refuses '').
          label="Unit cost"
          value={props.unitCost ?? ''}
          placeholder="e.g. 1200"
          onCommit={(v) => {
            if (!v.trim()) return setValues({ unitCost: undefined });
            const n = Number(v);
            if (!props.currency || !Number.isFinite(n) || !(n >= clo && n <= chi)) return false;
            setValues({ unitCost: n });
          }}
        />
        {props.unitCost === undefined && !props.currency && (
          <small className="cad-muted">Set the currency before the unit cost.</small>
        )}
        <CommitInput
          label="Supplier"
          value={props.supplier ?? ''}
          onCommit={(v) => setValues({ supplier: v.trim() || undefined })}
        />
      </fieldset>
    </Section>
  );
}
