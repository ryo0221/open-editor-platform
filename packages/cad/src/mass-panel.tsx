/**
 * CR7a (docs/cad/car-design.md, A3): the assembly's mass and centre of mass, each direct
 * component's share, and the front/rear split between two axles (the components chosen for each,
 * e.g. the two front wheels). Bodies without a density, sheets without a thickness and versions
 * not evaluated yet are listed as left out, never counted as 0; so is a part this person may no
 * longer read (not even its bodies named). A pattern's copies are rows of their own. Nothing is
 * weighed from a reference evaluation (another build's shapes). The axles are a view setting (not
 * saved in the document).
 */
import { useState, useSyncExternalStore } from 'react';
import { axleSplit, cadMass, componentCentre, expandAssembly } from '@editor-platform/cad-core';
import type { CadAssembly } from './assembly';
import type { CadSnapshot } from './controller';
import { fmtGrouped } from './dimension-fields';
import { stepName } from './joint-authoring';

const gapText = {
  'mass-missing': 'no density',
  'mass-thickness-missing': 'sheet without a thickness',
  'mass-not-evaluated': 'not calculated yet',
  'mass-no-access': 'no read access',
  'mass-part-missing': 'version not available',
  'mass-part-failed': 'version could not be calculated',
  'mass-part-unavailable': 'version not calculated with this build',
} as const;
const point = (p: readonly number[]) => `${p.map((v) => fmtGrouped(v, 1)).join(', ')} mm`;

export function MassSection({
  assembly,
  snapshot,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
}) {
  useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const [front, setFront] = useState<string[]>([]);
  const [rear, setRear] = useState<string[]>([]);
  const doc = snapshot.content;
  if (!doc.components.length) return null;
  const { evaluation } = snapshot;
  const withheld =
    evaluation?.status !== 'ok'
      ? undefined
      : evaluation.reference
        ? 'Mass is measured only on shapes calculated with this document\u2019s own kernel build.'
        : evaluation.assembly?.poseMismatch?.length
          ? 'Mass is measured once the saved poses match their joints: solve the poses again.'
          : undefined;
  if (withheld)
    return (
      <div className="cad-forms" data-testid="cad-mass-total">
        <h3>Mass</h3>
        <p className="cad-muted">{withheld}</p>
      </div>
    );
  const own = evaluation?.status === 'ok' ? evaluation.bodies : undefined;
  const result = cadMass(doc, own, assembly.lookup, assembly.versions(evaluation), assembly.access);
  // Each direct component and each pattern copy (its first path step), in assembly order.
  const steps = [
    ...new Set(expandAssembly(doc, assembly.lookup).occurrences.map((o) => o.path[0]!)),
  ].map((id) => ({ id, name: stepName(doc, id) ?? id }));
  const ids = new Set(steps.map((s) => s.id));
  const chosen = (list: string[]) => list.filter((id) => ids.has(id)).map((id) => [id]);
  const split =
    front.length && rear.length ? axleSplit(result, chosen(front), chosen(rear)) : undefined;
  const axle = (label: string, value: string[], onChange: (v: string[]) => void) => (
    <label className="ep-field">
      {label}
      <select
        multiple
        value={value}
        onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}
      >
        {steps.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="cad-forms" data-testid="cad-mass-total">
      <h3>Mass</h3>
      <dl className="cad-metrics">
        <dt>Total</dt>
        <dd data-testid="cad-mass-kg">{fmtGrouped(result.massKg, 3)} kg</dd>
        <dt>Centre of mass</dt>
        <dd data-testid="cad-mass-centre">
          {result.centroidMm ? point(result.centroidMm) : 'None'}
        </dd>
      </dl>
      <table className="cad-migration" aria-label="Mass by component">
        <thead>
          <tr>
            <th scope="col">Component</th>
            <th scope="col">Mass</th>
            <th scope="col">Centre</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((c) => {
            const kg = result.items
              .filter((i) => i.path[0] === c.id)
              .reduce((t, i) => t + i.massKg, 0);
            const centre = componentCentre(result, [c.id]);
            return (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{fmtGrouped(kg, 3)} kg</td>
                <td>{centre ? point(centre) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {result.leftOut.length > 0 && (
        <details data-testid="cad-mass-left-out">
          <summary>Left out: {result.leftOut.length}</summary>
          <ul>
            {result.leftOut.map((l) => (
              <li key={`${l.path.join('/')}:${l.bodyId}`}>
                {[
                  ...l.path.map((id, i) => (i === 0 ? (stepName(doc, id) ?? id) : id)),
                  l.name,
                ].join(' / ')}
                : {gapText[l.code]}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="cad-row">
        {axle('Front axle', front, setFront)}
        {axle('Rear axle', rear, setRear)}
      </div>
      <p className="cad-muted" data-testid="cad-mass-split">
        {!split
          ? 'Choose the components of each axle for the front/rear split.'
          : 'code' in split
            ? split.code === 'mass-axle-empty'
              ? 'An axle weighs nothing yet: give its parts a density.'
              : split.code === 'mass-axle-same'
                ? 'The two axles are at the same place.'
                : 'Nothing weighs yet.'
            : `Front ${fmtGrouped(split.front * 100, 1)} % · rear ${fmtGrouped(
                split.rear * 100,
                1,
              )} % (axles ${fmtGrouped(split.wheelbaseMm, 0)} mm apart)`}
      </p>
    </div>
  );
}
