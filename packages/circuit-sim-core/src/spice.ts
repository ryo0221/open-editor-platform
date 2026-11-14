import { circuitLedModels, circuitSwitchClosed, type CircuitDrive } from './dc';
import type { Circuit, CircuitElement } from './circuit';

/**
 * The circuit as a SPICE netlist (`.cir`, docs/cad/circuit-simulation.md, SL4), to check a
 * result in another simulator. Ground is node 0; other nodes keep their net names with
 * characters SPICE reads as separators replaced. Switches are written as resistors in the state
 * given (open unless listed). The MOSFET is level 1 with KP = k (W = L) and IS = 0, so its body diodes
 * carry only gmin, as in the calculation. GPIO drives (`drives`) are written as the solver stamps
 * them: an output is a source behind its resistance, an input's pull a resistor (to a source for
 * a pull-up).
 */
export function circuitSpice(
  circuit: Circuit,
  options: {
    title?: string;
    switches?: Readonly<Record<string, boolean>>;
    drives?: readonly CircuitDrive[];
  } = {},
): string {
  const used = new Set<string>(['0']);
  const unique = (n: string) => {
    const base = n.replace(/[^A-Za-z0-9_+\-.]/g, '_') || 'N';
    let name = base === '0' ? 'N0' : base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    used.add(name.toLowerCase());
    return name;
  };
  const names = circuit.nodes.map((n, i) => (i === 0 ? '0' : unique(n)));
  const node = (e: CircuitElement, t: string) => names[e.nodes[t]];
  // Card names (letter + reference) are unique once sanitised ("+5V" and "-5V" both read _5V).
  const cards = new Set<string>();
  const card = (letter: string, e: CircuitElement) => {
    const base = `${letter}${e.ref.replace(/[^A-Za-z0-9_]/g, '_')}`;
    let name = base;
    for (let k = 2; cards.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    cards.add(name.toLowerCase());
    return name;
  };
  const lines = [`* ${(options.title ?? 'circuit').replace(/\s+/g, ' ')}`];
  // Model name → card; a parameter set gets its own name (suffixed when two sets read alike).
  const models = new Map<string, string>();
  const modelByBody = new Map<string, string>();
  const model = (base: string, body: string) => {
    let name = modelByBody.get(body);
    if (name) return name;
    const clean = base.replace(/[^A-Za-z0-9_]/g, '_');
    name = clean;
    for (let k = 2; [...models.keys()].some((m) => m.toLowerCase() === name!.toLowerCase()); k++)
      name = `${clean}_${k}`;
    modelByBody.set(body, name);
    models.set(name, `.model ${name} ${body}`);
    return name;
  };
  for (const e of circuit.elements) {
    const p = e.params;
    switch (e.kind) {
      case 'resistor':
        lines.push(`${card('R', e)} ${node(e, 'a')} ${node(e, 'b')} ${p.ohms}`);
        break;
      case 'switch':
        lines.push(
          `${card('RSW', e)} ${node(e, 'a')} ${node(e, 'b')} ${circuitSwitchClosed(options.switches, e.id) ? p.closedOhms : p.openOhms}`,
        );
        break;
      case 'capacitor':
        lines.push(`${card('C', e)} ${node(e, 'a')} ${node(e, 'b')} ${p.farads}`);
        break;
      case 'inductor':
        lines.push(`${card('L', e)} ${node(e, 'a')} ${node(e, 'b')} ${p.henries}`);
        break;
      case 'vsource':
        lines.push(`${card('V', e)} ${node(e, 'plus')} ${node(e, 'minus')} DC ${p.volts}`);
        break;
      case 'isource':
        // SPICE's current flows from the first node through the source to the second.
        lines.push(`${card('I', e)} ${node(e, 'minus')} ${node(e, 'plus')} DC ${p.amps}`);
        break;
      case 'diode': {
        const m = model(
          `D_${String(p.saturationAmps)}_${String(p.emission)}`,
          `D(IS=${p.saturationAmps} N=${p.emission})`,
        );
        lines.push(`${card('D', e)} ${node(e, 'anode')} ${node(e, 'cathode')} ${m}`);
        break;
      }
      case 'led': {
        const c = circuitLedModels[p.color as string];
        const m = model(
          `LED_${String(p.color).toUpperCase()}`,
          `D(IS=${c.saturationAmps.toExponential(6)} N=${c.emission})`,
        );
        lines.push(`${card('D', e)} ${node(e, 'anode')} ${node(e, 'cathode')} ${m}`);
        break;
      }
      case 'bjt': {
        const pol = p.polarity === 'pnp' ? 'PNP' : 'NPN';
        const m = model(`Q_${pol}_${String(p.beta)}`, `${pol}(IS=1e-14 BF=${p.beta} BR=1)`);
        lines.push(
          `${card('Q', e)} ${node(e, 'collector')} ${node(e, 'base')} ${node(e, 'emitter')} ${m}`,
        );
        break;
      }
      case 'mosfet': {
        const ch = p.channel === 'p' ? 'PMOS' : 'NMOS';
        const m = model(
          `M_${ch}_${String(p.thresholdVolts)}_${String(p.k)}`,
          `${ch}(LEVEL=1 VTO=${p.thresholdVolts} KP=${p.k} IS=0)`,
        );
        const s = node(e, 'source');
        lines.push(`${card('M', e)} ${node(e, 'drain')} ${node(e, 'gate')} ${s} ${s} ${m} L=1 W=1`);
        break;
      }
    }
  }
  for (const d of options.drives ?? []) {
    const at = names[d.node];
    const e = { ref: d.id } as CircuitElement;
    if (d.kind === 'output') {
      const inner = unique(`drv_${d.id}`);
      lines.push(`${card('VDRV_', e)} ${inner} 0 DC ${d.volts}`);
      lines.push(`${card('RDRV_', e)} ${inner} ${at} ${d.ohms}`);
    } else if (d.pull === 'up') {
      const inner = unique(`pull_${d.id}`);
      lines.push(`${card('VPULL_', e)} ${inner} 0 DC ${d.supplyVolts}`);
      lines.push(`${card('RPULL_', e)} ${inner} ${at} ${d.pullOhms}`);
    } else if (d.pull === 'down') {
      lines.push(`${card('RPULL_', e)} ${at} 0 ${d.pullOhms}`);
    }
  }
  lines.push(...[...models.keys()].sort().map((k) => models.get(k)!), '.op', '.end', '');
  return lines.join('\n');
}
