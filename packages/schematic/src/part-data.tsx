import { useMemo, useState } from 'react';
import { Section } from '@editor-platform/editor-ui';
import { pcbGenerators } from '@editor-platform/pcb-core';
import {
  schematicErc,
  schematicFootprintPads,
  schematicFootprintStart,
  schematicModelFor,
  schematicModelSpecs,
  schematicSymbolSpecs,
  schematicWithFootprint,
  type SchematicDocument,
  type SchematicFootprintRef,
  type SchematicNet,
  type SchematicPart,
  type SchematicSymbol,
  type SchematicSymbolParams,
} from '@editor-platform/schematic-core';
import type { SchematicController } from './controller';
import { Choice, Field, useSelect, useSettle } from './fields';

/**
 * The SL2 parts of the Surface (docs/cad/circuit-simulation.md): a part's footprint, pin map,
 * circuit model and not-connected pins; making a symbol from a generator; and the ERC list.
 */

const siPrefixes: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
};
/** "330", "4.7k", "100n", "1e-7" → a number; undefined when it is not one. */
export function parseSi(text: string): number | undefined {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([pnuµmkMG]?)\s*$/.exec(text);
  if (!m) return undefined;
  const v = Number(m[1]) * siPrefixes[m[2]];
  return Number.isFinite(v) ? v : undefined;
}
/** A number with an SI prefix, 4 significant digits ("4.7k", "100n"). */
export function formatSi(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  const [p, f] =
    (
      [
        ['G', 1e9],
        ['M', 1e6],
        ['k', 1e3],
        ['', 1],
        ['m', 1e-3],
        ['u', 1e-6],
        ['n', 1e-9],
        ['p', 1e-12],
      ] as const
    ).find(([, f]) => a >= f) ?? (['p', 1e-12] as const);
  return `${Number((v / f).toPrecision(4))}${p}`;
}

const none = { value: '', label: '(none)' };

/** Footprint, pin map, model and not-connected pins of one part. */
export function PartDataInspector({
  controller,
  part,
  symbol,
  readOnly,
}: {
  controller: SchematicController;
  part: SchematicPart;
  symbol: SchematicSymbol;
  readOnly: boolean;
}) {
  const settle = useSettle();
  const update = (next: SchematicPart) => settle(() => controller.updatePart(next));
  const edit = (next: SchematicPart) => !controller.updatePart(next);
  const pins = symbol.pins;
  const pinText = (n: string) => {
    const pin = pins.find((p) => p.number === n);
    return pin && pin.name !== '~' && pin.name !== n ? `${n} (${pin.name})` : n;
  };
  const pads = useMemo(() => {
    if (!part.footprint) return [];
    try {
      return schematicFootprintPads(part.footprint);
    } catch {
      return [];
    }
  }, [part.footprint]);
  const footprintSpec = part.footprint && pcbGenerators.get(part.footprint.generator);
  const setFootprint = (ref: SchematicFootprintRef | undefined) =>
    update(schematicWithFootprint(part, symbol, ref));
  const model = part.model;
  const modelSpec = model && schematicModelSpecs.get(model.kind);

  return (
    <>
      <Section title="Footprint">
        <Choice
          label="Footprint"
          value={part.footprint?.generator ?? ''}
          disabled={readOnly}
          options={[
            none,
            ...[...pcbGenerators.values()].map((g) => ({ value: g.kind, label: g.label })),
          ]}
          onChange={(kind) =>
            // Sized for the symbol's pins, so every pin gets a pad where the generator allows.
            setFootprint(kind ? schematicFootprintStart(symbol, kind) : undefined)
          }
        />
        {footprintSpec?.params.map((p) => {
          const value = part.footprint!.params[p.name] ?? p.default;
          const set = (v: number | string) =>
            schematicWithFootprint(
              part,
              symbol,
              {
                generator: part.footprint!.generator,
                params: { ...part.footprint!.params, [p.name]: v },
              },
              { keep: true },
            );
          return p.options ? (
            <Choice
              key={p.name}
              label={p.label}
              value={String(value)}
              options={p.options}
              disabled={readOnly}
              onChange={(v) => update(set(v))}
            />
          ) : (
            <Field
              key={p.name}
              readOnly={readOnly}
              label={p.label}
              value={String(value)}
              onCommit={(v) => {
                const n = Number(v);
                return Number.isFinite(n) && v.trim() !== '' && edit(set(n));
              }}
            />
          );
        })}
        {part.footprint && (
          <table className="sch-pinmap" aria-label="Pin map">
            <tbody>
              {pins.map((pin) => (
                <tr key={pin.number}>
                  <th scope="row">Pin {pinText(pin.number)}</th>
                  <td>
                    <select
                      aria-label={`Pad for pin ${pin.number}`}
                      value={part.pinMap?.[pin.number] ?? ''}
                      disabled={readOnly}
                      onChange={(e) => {
                        const pad = e.target.value;
                        const pinMap = { ...part.pinMap };
                        if (pad) pinMap[pin.number] = pad;
                        else delete pinMap[pin.number];
                        update({ ...part, pinMap });
                      }}
                    >
                      <option value="">—</option>
                      {pads.map((pad) => (
                        <option key={pad} value={pad}>
                          Pad {pad}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Model">
        <Choice
          label="Model"
          value={model?.kind ?? ''}
          disabled={readOnly}
          options={[
            none,
            ...[...schematicModelSpecs.values()].map((m) => ({ value: m.kind, label: m.label })),
          ]}
          onChange={(kind) => {
            const { model: _old, ...rest } = part;
            if (!kind) return update(rest);
            const next = schematicModelFor(symbol, kind);
            if (next) update({ ...rest, model: next });
            else controller.report({ code: 'model-terminals', ids: [part.id] });
          }}
        />
        {!model && <p className="sch-facts">Left out of the circuit calculation.</p>}
        {model &&
          modelSpec?.terminals.map((t) => (
            <Choice
              key={t}
              label={`Terminal ${t}`}
              value={model.terminals[t] ?? ''}
              options={pins.map((p) => ({ value: p.number, label: `Pin ${pinText(p.number)}` }))}
              disabled={readOnly}
              onChange={(pin) => {
                // A terminal already on that pin takes this one's pin: the two swap in one edit
                // (reversing a source, reordering a transistor), never two terminals on one pin.
                const terminals = { ...model.terminals };
                const other = Object.keys(terminals).find((k) => k !== t && terminals[k] === pin);
                if (other !== undefined && terminals[t] !== undefined)
                  terminals[other] = terminals[t];
                terminals[t] = pin;
                update({ ...part, model: { ...model, terminals } });
              }}
            />
          ))}
        {model &&
          modelSpec?.params.map((p) => {
            const value = model.params[p.name];
            const set = (v: number | string): SchematicPart => ({
              ...part,
              model: { ...model, params: { ...model.params, [p.name]: v } },
            });
            return p.options ? (
              <Choice
                key={p.name}
                label={p.label}
                value={String(value)}
                options={p.options}
                disabled={readOnly}
                onChange={(v) => update(set(v))}
              />
            ) : (
              <Field
                key={p.name}
                readOnly={readOnly}
                label={p.label}
                value={typeof value === 'number' ? formatSi(value) : String(value)}
                onCommit={(v) => {
                  const n = parseSi(v);
                  if (n === undefined) {
                    controller.report({ code: 'model-param', ids: [part.id] });
                    return false;
                  }
                  return edit(set(n));
                }}
              />
            );
          })}
      </Section>
      <Section title="Pins">
        <ul className="sch-list" aria-label="Pins not connected">
          {pins.map((pin) => (
            <li key={pin.number}>
              <label className="sch-check">
                <input
                  type="checkbox"
                  aria-label={`Pin ${pin.number} not connected`}
                  checked={part.noConnect?.includes(pin.number) ?? false}
                  disabled={readOnly}
                  onChange={(e) => {
                    const on = e.target.checked;
                    const rest = (part.noConnect ?? []).filter((n) => n !== pin.number);
                    const list = on ? [...rest, pin.number] : rest;
                    const { noConnect: _old, ...base } = part;
                    update(list.length ? { ...base, noConnect: list } : base);
                  }}
                />
                Pin {pinText(pin.number)} · {pin.type} · not connected
              </label>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/** Makes a symbol from a generator; `onAdded` gets its ID (to place it next). */
export function SymbolGenerator({
  controller,
  readOnly,
  onAdded,
}: {
  controller: SchematicController;
  readOnly: boolean;
  onAdded(id: string): void;
}) {
  const settle = useSettle();
  const [kind, setKind] = useState('ic');
  const spec = schematicSymbolSpecs.get(kind)!;
  const [params, setParams] = useState<SchematicSymbolParams>({});
  const value = (name: string) => params[name] ?? spec.params.find((p) => p.name === name)!.default;
  return (
    <Section title="New symbol">
      <Choice
        label="Generator"
        value={kind}
        disabled={readOnly}
        options={[...schematicSymbolSpecs.values()].map((s) => ({ value: s.kind, label: s.label }))}
        onChange={(k) => {
          setKind(k);
          setParams({});
        }}
      />
      {spec.params.map((p) =>
        p.boolean ? (
          <label key={p.name} className="ep-field sch-check">
            <input
              type="checkbox"
              aria-label={p.label}
              checked={value(p.name) === true}
              disabled={readOnly}
              onChange={(e) => setParams({ ...params, [p.name]: e.target.checked })}
            />
            {p.label}
          </label>
        ) : p.options ? (
          <Choice
            key={p.name}
            label={p.label}
            value={String(value(p.name))}
            options={p.options}
            disabled={readOnly}
            onChange={(v) => setParams({ ...params, [p.name]: v })}
          />
        ) : (
          <label key={p.name} className="ep-field">
            {p.label}
            <input
              aria-label={p.label}
              type={p.text ? 'text' : 'number'}
              value={String(value(p.name))}
              disabled={readOnly}
              onChange={(e) =>
                setParams({
                  ...params,
                  [p.name]: p.text ? e.target.value : Number(e.target.value),
                })
              }
            />
          </label>
        ),
      )}
      <div className="sch-actions">
        <button
          type="button"
          disabled={readOnly}
          onClick={() =>
            settle(() => {
              const r = controller.addSymbol(kind, params);
              if (r.id) onAdded(r.id);
            })
          }
        >
          Add symbol
        </button>
      </div>
    </Section>
  );
}

/** The ERC findings; a click selects the parts they name. */
export function ErcList({
  controller,
  doc,
  nets,
}: {
  controller: SchematicController;
  doc: SchematicDocument;
  nets: readonly SchematicNet[];
}) {
  const select = useSelect(controller);
  const issues = useMemo(() => schematicErc(doc, nets), [doc, nets]);
  const refOf = new Map(doc.parts.map((p) => [p.id, p.ref]));
  return (
    <Section title={`ERC (${issues.length})`}>
      {issues.length === 0 ? (
        <p className="sch-empty" data-testid="sch-erc-clean">
          No ERC findings.
        </p>
      ) : (
        <ul className="sch-list" aria-label="ERC" data-testid="sch-erc">
          {issues.map((i, k) => (
            <li key={k} data-code={i.code} className={`sch-${i.severity}`}>
              <button type="button" onClick={() => select([...new Set(i.pins.map(([p]) => p))])}>
                {i.code} · {i.net} ·{' '}
                {i.pins.map(([p, q]) => `${refOf.get(p) ?? p}.${q}`).join(', ')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
