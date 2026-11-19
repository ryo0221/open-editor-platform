/**
 * PD5 (docs/cad/product-design.md, PD5 ばね): a spring feature's fields and its textbook
 * estimate. Each commit is one edit; values the spring cannot have (turns that touch, a strip
 * that does not fit its barrel) are refused by validation with their code. The estimate is read
 * from the arguments alone (never stored) and shown as a guide: no fatigue or friction (PD-U5).
 */
import { CommitInput } from '@editor-platform/editor-ui';
import {
  defaultCoilSpringArgs,
  defaultSpiralSpringArgs,
  parameterValues,
  resolveSpring,
  springEstimate,
  springProblem,
  type CadCoilSpringArgs,
  type CadDocument,
  type CadSpiralSpringArgs,
  type CadSpringArgs,
  type CadSpringEstimate,
} from '@editor-platform/cad-core';
import { AngleField, fmtGrouped, LengthField } from './dimension-fields';

const mm = (v: number) => ({ literalMm: v });

function NumberField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  placeholder?: string;
  /** Called with undefined for an empty field. */
  onCommit: (v: number | undefined) => void;
}) {
  return (
    <CommitInput
      label={label}
      value={value ?? ''}
      placeholder={placeholder}
      onCommit={(text) => {
        if (!text.trim()) return onCommit(undefined);
        const v = Number(text);
        if (Number.isFinite(v)) onCommit(v);
      }}
    />
  );
}

export function SpringFields({
  args: a,
  doc,
  onCommit,
}: {
  args: CadSpringArgs;
  doc: CadDocument;
  onCommit: (args: CadSpringArgs) => void;
}) {
  const at = { origin: a.origin, orientation: a.orientation };
  return (
    <>
      <label className="ep-field">
        Spring form
        <select
          value={a.form}
          onChange={(e) =>
            onCommit(
              e.target.value === 'coil' ? defaultCoilSpringArgs(at) : defaultSpiralSpringArgs(at),
            )
          }
        >
          <option value="coil">Coil</option>
          <option value="spiral">Spiral</option>
        </select>
      </label>
      {a.form === 'coil' ? (
        <CoilFields args={a} doc={doc} onCommit={onCommit} />
      ) : (
        <SpiralFields args={a} doc={doc} onCommit={onCommit} />
      )}
      <SpringEstimateView args={a} doc={doc} />
    </>
  );
}

function CoilFields({
  args: a,
  doc,
  onCommit,
}: {
  args: CadCoilSpringArgs;
  doc: CadDocument;
  onCommit: (args: CadCoilSpringArgs) => void;
}) {
  return (
    <>
      <label className="ep-field">
        Spring use
        <select
          value={a.use}
          onChange={(e) => {
            // Each use keeps only its own working point.
            const { deflection, angle, initialTensionN, ...rest } = a;
            void initialTensionN;
            const use = e.target.value as CadCoilSpringArgs['use'];
            const shear = a.material.shearModulusMpa ?? 79_000;
            onCommit({
              ...rest,
              use,
              material:
                use === 'torsion'
                  ? { youngsModulusMpa: a.material.youngsModulusMpa }
                  : { youngsModulusMpa: a.material.youngsModulusMpa, shearModulusMpa: shear },
              ...(use === 'torsion' ? angle && { angle } : deflection && { deflection }),
            });
          }}
        >
          <option value="compression">Compression</option>
          <option value="extension">Extension</option>
          <option value="torsion">Torsion</option>
        </select>
      </label>
      <LengthField
        label="Wire diameter"
        length={a.wireDiameter}
        doc={doc}
        onCommit={(wireDiameter) => onCommit({ ...a, wireDiameter })}
      />
      <LengthField
        label="Mean diameter"
        length={a.meanDiameter}
        doc={doc}
        onCommit={(meanDiameter) => onCommit({ ...a, meanDiameter })}
      />
      <LengthField
        label="Pitch"
        length={a.pitch}
        doc={doc}
        onCommit={(pitch) => onCommit({ ...a, pitch })}
      />
      <NumberField
        label="Turns"
        value={a.coils}
        onCommit={(coils) => coils !== undefined && onCommit({ ...a, coils })}
      />
      <NumberField
        label="Active turns"
        value={a.activeCoils}
        onCommit={(activeCoils) => activeCoils !== undefined && onCommit({ ...a, activeCoils })}
      />
      <label className="ep-field">
        Hand
        <select
          value={a.hand}
          onChange={(e) => onCommit({ ...a, hand: e.target.value as 'right' | 'left' })}
        >
          <option value="right">Right</option>
          <option value="left">Left</option>
        </select>
      </label>
      <NumberField
        label="Young's modulus (MPa)"
        value={a.material.youngsModulusMpa}
        onCommit={(v) =>
          v !== undefined && onCommit({ ...a, material: { ...a.material, youngsModulusMpa: v } })
        }
      />
      {a.use !== 'torsion' && (
        <NumberField
          label="Shear modulus (MPa)"
          value={a.material.shearModulusMpa}
          onCommit={(v) =>
            v !== undefined && onCommit({ ...a, material: { ...a.material, shearModulusMpa: v } })
          }
        />
      )}
      {a.use === 'torsion' ? (
        <WorkingAngle
          angle={a.angle}
          doc={doc}
          onCommit={(angle) => {
            const { angle: _a, ...rest } = a;
            void _a;
            onCommit(angle ? { ...rest, angle } : rest);
          }}
        />
      ) : (
        <>
          {a.deflection ? (
            <LengthField
              label="Working deflection"
              length={a.deflection}
              doc={doc}
              onCommit={(deflection) => onCommit({ ...a, deflection })}
            />
          ) : (
            <NumberField
              label="Working deflection (mm)"
              value={undefined}
              placeholder="optional"
              onCommit={(v) => v !== undefined && onCommit({ ...a, deflection: mm(v) })}
            />
          )}
          {a.use === 'extension' && (
            <NumberField
              label="Initial tension (N)"
              value={a.initialTensionN}
              placeholder="optional"
              onCommit={(v) => {
                const { initialTensionN: _t, ...rest } = a;
                void _t;
                onCommit(v === undefined ? rest : { ...rest, initialTensionN: v });
              }}
            />
          )}
        </>
      )}
    </>
  );
}

function WorkingAngle({
  angle,
  doc,
  onCommit,
}: {
  angle: CadSpiralSpringArgs['angle'];
  doc: CadDocument;
  onCommit: (angle: CadSpiralSpringArgs['angle']) => void;
}) {
  return angle ? (
    <AngleField label="Working angle" angle={angle} doc={doc} onCommit={onCommit} />
  ) : (
    <NumberField
      label="Working angle (°)"
      value={undefined}
      placeholder="optional"
      onCommit={(v) => v !== undefined && onCommit({ literalRad: (v * Math.PI) / 180 })}
    />
  );
}

function SpiralFields({
  args: a,
  doc,
  onCommit,
}: {
  args: CadSpiralSpringArgs;
  doc: CadDocument;
  onCommit: (args: CadSpiralSpringArgs) => void;
}) {
  const barrel = a.barrel;
  return (
    <>
      <label className="ep-field">
        Spring use
        <select
          value={a.use}
          onChange={(e) => {
            const { barrel: _b, ...rest } = a;
            void _b;
            onCommit({ ...rest, use: e.target.value as CadSpiralSpringArgs['use'] });
          }}
        >
          <option value="mainspring">Mainspring</option>
          <option value="hairspring">Hairspring</option>
        </select>
      </label>
      <LengthField
        label="Thickness"
        length={a.thickness}
        doc={doc}
        onCommit={(thickness) => onCommit({ ...a, thickness })}
      />
      <LengthField
        label="Height"
        length={a.height}
        doc={doc}
        onCommit={(height) => onCommit({ ...a, height })}
      />
      <LengthField
        label="Inner radius"
        length={a.innerRadius}
        doc={doc}
        onCommit={(innerRadius) => onCommit({ ...a, innerRadius })}
      />
      <LengthField
        label="Pitch"
        length={a.pitch}
        doc={doc}
        onCommit={(pitch) => onCommit({ ...a, pitch })}
      />
      <NumberField
        label="Turns"
        value={a.turns}
        onCommit={(turns) => turns !== undefined && onCommit({ ...a, turns })}
      />
      <NumberField
        label="Young's modulus (MPa)"
        value={a.material.youngsModulusMpa}
        onCommit={(v) => v !== undefined && onCommit({ ...a, material: { youngsModulusMpa: v } })}
      />
      <WorkingAngle
        angle={a.angle}
        doc={doc}
        onCommit={(angle) => {
          const { angle: _a, ...rest } = a;
          void _a;
          onCommit(angle ? { ...rest, angle } : rest);
        }}
      />
      {a.use === 'mainspring' &&
        (barrel ? (
          <>
            <LengthField
              label="Barrel inner radius"
              length={barrel.innerRadius}
              doc={doc}
              onCommit={(innerRadius) => onCommit({ ...a, barrel: { ...barrel, innerRadius } })}
            />
            <LengthField
              label="Arbor radius"
              length={barrel.arborRadius}
              doc={doc}
              onCommit={(arborRadius) => onCommit({ ...a, barrel: { ...barrel, arborRadius } })}
            />
            <NumberField
              label="Hours per barrel turn"
              value={barrel.hoursPerTurn}
              placeholder="optional"
              onCommit={(v) => {
                const { hoursPerTurn: _h, ...rest } = barrel;
                void _h;
                onCommit({ ...a, barrel: v === undefined ? rest : { ...rest, hoursPerTurn: v } });
              }}
            />
            <button
              type="button"
              onClick={() => {
                const { barrel: _b, ...rest } = a;
                void _b;
                onCommit(rest);
              }}
            >
              Remove barrel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() =>
              onCommit({
                ...a,
                barrel: { innerRadius: mm(5.1), arborRadius: mm(1.6), hoursPerTurn: 8 },
              })
            }
          >
            Add barrel
          </button>
        ))}
    </>
  );
}

const g = (v: number, digits = 3) =>
  Math.abs(v) < 0.01 && v !== 0 ? String(Number(v.toPrecision(3))) : fmtGrouped(v, digits);
/** The estimate's lines as label and value text (for the inspector and its tests). */
export function springEstimateLines(e: CadSpringEstimate): [string, string][] {
  const out: [string, string][] = [['Spring rate', `${g(e.rate, 4)} ${e.rateUnit}`]];
  if (e.springIndex !== undefined) out.push(['Spring index', g(e.springIndex)]);
  if (e.freeLengthMm !== undefined) out.push(['Free length', `${g(e.freeLengthMm)} mm`]);
  if (e.solidLengthMm !== undefined) out.push(['Solid length', `${g(e.solidLengthMm)} mm`]);
  if (e.stripLengthMm !== undefined) out.push(['Strip length', `${g(e.stripLengthMm, 1)} mm`]);
  const w = e.working;
  if (w) {
    if (w.forceN !== undefined) out.push(['Force at working', `${g(w.forceN)} N`]);
    if (w.torqueNmm !== undefined) out.push(['Torque at working', `${g(w.torqueNmm, 4)} N·mm`]);
    out.push(['Stress at working', `${g(w.stressMpa, 0)} MPa`]);
  }
  if (e.solid) out.push(['Stress at solid', `${g(e.solid.stressMpa, 0)} MPa`]);
  const b = e.barrel;
  if (b) {
    out.push(
      ['Usable barrel turns', g(b.usableTurns, 2)],
      ['Barrel fill', `${g(b.fill * 100, 0)} %`],
      ['Torque fully wound', `${g(b.fullTorqueNmm, 3)} N·mm`],
      ['Stress fully wound', `${g(b.fullStressMpa, 0)} MPa`],
    );
    if (b.runHours !== undefined) out.push(['Running time', `${g(b.runHours, 1)} h`]);
  }
  return out;
}

function SpringEstimateView({ args, doc }: { args: CadSpringArgs; doc: CadDocument }) {
  let spec;
  try {
    spec = resolveSpring(args, parameterValues(doc));
  } catch {
    return null;
  }
  const problem = springProblem(spec);
  return (
    <div className="cad-spring-estimate" data-testid="cad-spring-estimate">
      <strong>Estimate (textbook formulas; no fatigue or friction)</strong>
      {problem ? (
        <p className="cad-muted">No estimate: {problem.code}</p>
      ) : (
        <dl>
          {springEstimateLines(springEstimate(spec)).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
