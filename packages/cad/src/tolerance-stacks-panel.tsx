/**
 * PD3 (docs/cad/product-design.md, PD3 公差の積み上げ): the document's tolerance stacks. Each
 * stack adds signed contributors (a length parameter with its tolerance, or a PMI dimension of an
 * import) and shows the result by the worst case, the root sum of squares and a seeded Monte
 * Carlo run beside its band. The numbers are worked out from the current parameters and PMI and
 * never stored; a stack whose contributor no longer resolves is shown stale with the reason.
 */
import { useMemo, useRef, useState } from 'react';
import { Section } from '@editor-platform/editor-ui';
import {
  cadToleranceStackLimits,
  parameterValues,
  toleranceStackReport,
  toleranceStackResult,
  type CadPmiDimension,
  type CadStackBand,
  type CadStackContributor,
  type CadStackDistribution,
  type CadStackInput,
  type CadStackResult,
  type CadStackStale,
  type CadToleranceStack,
} from '@editor-platform/cad-core';
import type { CadController, CadSnapshot } from './controller';
import { fmtGrouped } from './dimension-fields';

const staleText: Record<CadStackStale, string> = {
  'stack-parameter-missing': 'its parameter is gone',
  'stack-pmi-missing': 'its PMI dimension is gone',
  'stack-pmi-stale': 'its PMI dimension is stale',
  'stack-pmi-kind': 'its PMI item is not a length dimension',
  'stack-pmi-tolerance': 'its PMI dimension has no usable tolerance',
};
const mm = (v: number) => `${fmtGrouped(v, 4)} mm`;
const signed = (v: number) => (v >= 0 ? `+${fmtGrouped(v, 4)}` : `−${fmtGrouped(-v, 4)}`);
const parse = (text: string) => (text.trim() === '' ? undefined : Number(text));

/**
 * The document's stack results with its PMI. A stack is worked out again only when it, the
 * parameters it reads or the PMI items it reads change: its Monte Carlo run can take a while.
 */
export function useToleranceStacks(
  controller: CadController,
  snapshot: CadSnapshot,
): CadStackResult[] {
  const doc = snapshot.content;
  const cache = useRef(new Map<string, CadStackResult>());
  return useMemo(() => {
    const stacks = doc.toleranceStacks ?? [];
    if (!stacks.length) return [];
    const values = parameterValues(doc);
    const views = new Map<string, ReturnType<CadController['bodyPmi']>>();
    const view = (bodyId: string) => {
      if (!views.has(bodyId))
        views.set(
          bodyId,
          doc.bodies.some((b) => b.id === bodyId)
            ? controller.bodyPmi(bodyId)
            : { state: { status: 'none' } },
        );
      return views.get(bodyId)!;
    };
    const input: CadStackInput = { pmi: (bodyId) => view(bodyId) };
    const next = new Map<string, CadStackResult>();
    const results = stacks.map((s) => {
      const read = s.contributors.map((x) => {
        if (x.source.kind === 'parameter') {
          const p = doc.parameters.find(
            (q) => q.id === (x.source as { parameterId: string }).parameterId,
          );
          return [p?.type, values.get(x.source.parameterId)?.value];
        }
        const v = view(x.source.bodyId);
        const itemId = x.source.itemId;
        return [v.asset?.items.find((i) => i.id === itemId), v.items?.get(itemId)];
      });
      const key = JSON.stringify([s, read]);
      const r = cache.current.get(key) ?? toleranceStackResult(doc, s, input, values);
      next.set(key, r);
      return r;
    });
    cache.current = next;
    return results;
  }, [controller, doc, snapshot.meshes]);
}

function Flag({ status }: { status?: CadStackBand }) {
  return status ? <span className={`cad-targets-flag ${status}`}>{status}</span> : null;
}

export function ToleranceStacksSection({
  controller,
  snapshot,
  editable,
  name,
  results,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
  editable: boolean;
  /** The document's name, for the exported file. */
  name: string;
  results: readonly CadStackResult[];
}) {
  const doc = snapshot.content;
  const stacks = doc.toleranceStacks ?? [];
  const held = snapshot.busy || !!snapshot.sketch;
  const byId = new Map(results.map((r) => [r.id, r]));
  const lengths = doc.parameters.filter((p) => p.type === 'length');
  // A document of imported bodies may have PMI dimensions and no parameters: it can stack too.
  if (!lengths.length && !stacks.length && !pmiDimensions(controller, doc).length) return null;
  const exportJson = () => {
    const report = toleranceStackReport(doc, results, name);
    const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url,
      download: `${name}-tolerance-stacks.json`,
    }).click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <Section title={`Tolerance stacks (${stacks.length})`} open={stacks.length > 0}>
      <fieldset
        className="cad-targets"
        data-testid="cad-tolerance-stacks"
        disabled={held}
        key={snapshot.rejections}
      >
        <ul aria-label="Tolerance stacks" className="cad-targets-list cad-stacks-list">
          {stacks.map((s) => {
            const r = byId.get(s.id);
            const band = [
              s.min !== undefined ? `≥ ${mm(s.min)}` : '',
              s.max !== undefined ? `≤ ${mm(s.max)}` : '',
            ]
              .filter(Boolean)
              .join(', ');
            const mc = r?.monteCarlo;
            return (
              <li key={s.id} data-stack={s.id} data-status={r?.status ?? 'stale'}>
                <div className="cad-targets-head">
                  <span>
                    {s.name}
                    {s.requirement && <span className="cad-muted"> ({s.requirement})</span>}
                  </span>
                  <strong data-testid={`cad-stack-${s.id}-nominal`}>
                    {r?.status === 'ok' ? mm(r.nominal!) : 'stale'}
                  </strong>
                </div>
                {band && <div className="cad-muted">Band {band}</div>}
                {r?.status === 'ok' && (
                  <dl className="cad-stack-methods">
                    <dt>Worst case</dt>
                    <dd data-testid={`cad-stack-${s.id}-worst`}>
                      {mm(r.worst!.min)} – {mm(r.worst!.max)} <Flag status={r.worst!.status} />
                    </dd>
                    <dt>RSS (±3σ)</dt>
                    <dd data-testid={`cad-stack-${s.id}-rss`}>
                      {mm(r.rss!.min)} – {mm(r.rss!.max)} <Flag status={r.rss!.status} />
                    </dd>
                    <dt>Monte Carlo</dt>
                    <dd data-testid={`cad-stack-${s.id}-mc`}>
                      mean {mm(mc!.mean)}, σ {mm(mc!.sigma)}, {mm(mc!.min)} – {mm(mc!.max)} ·{' '}
                      {fmtGrouped(mc!.outside, 0)}/{fmtGrouped(mc!.runs, 0)} outside{' '}
                      <Flag status={mc!.status} />
                      <span className="cad-muted"> (seed {mc!.seed})</span>
                    </dd>
                  </dl>
                )}
                <ol className="cad-stack-contributors" aria-label={`Contributors of ${s.name}`}>
                  {s.contributors.map((x) => {
                    const c = r?.contributors.find((y) => y.id === x.id);
                    return (
                      <li key={x.id} data-contributor={x.id} className={c?.reason ? 'stale' : ''}>
                        {x.sign > 0 ? '+' : '−'} {x.name}{' '}
                        <span className="cad-muted">({describeSource(doc, x)})</span>
                        {c?.nominal !== undefined && (
                          <>
                            {' '}
                            {fmtGrouped(c.nominal, 4)} {signed(c.upper!)}/{signed(c.lower!)} ·{' '}
                            {x.distribution}
                            {c.share !== undefined && <> · {fmtGrouped(c.share * 100, 1)}%</>}
                          </>
                        )}
                        {c?.reason && <> · {staleText[c.reason]}</>}
                      </li>
                    );
                  })}
                </ol>
                {editable && (
                  <button
                    type="button"
                    aria-label={`Remove ${s.name}`}
                    onClick={() =>
                      void controller.setToleranceStacks(stacks.filter((x) => x.id !== s.id))
                    }
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {editable && (
          <AddStack
            controller={controller}
            doc={doc}
            onAdd={(s) =>
              controller.setToleranceStacks([...stacks, { ...s, id: controller.newId('stack') }])
            }
          />
        )}
        {stacks.length > 0 && (
          <button type="button" onClick={exportJson}>
            Export stacks (JSON)
          </button>
        )}
      </fieldset>
    </Section>
  );
}

function describeSource(doc: CadSnapshot['content'], x: CadStackContributor) {
  const s = x.source;
  if (s.kind === 'parameter')
    return `parameter ${doc.parameters.find((p) => p.id === s.parameterId)?.name ?? s.parameterId}`;
  return `PMI ${s.itemId} of ${doc.bodies.find((b) => b.id === s.bodyId)?.name ?? s.bodyId}`;
}

/** Active bodies whose import kept PMI with a length dimension, and those dimensions. */
function pmiDimensions(controller: CadController, doc: CadSnapshot['content']) {
  return doc.bodies
    .filter((b) => b.state === 'active')
    .flatMap((b) => {
      const dims = (controller.bodyPmi(b.id).asset?.items ?? []).filter(
        (i): i is CadPmiDimension => i.kind === 'dimension' && !/Angular/.test(i.type),
      );
      return dims.length ? [{ body: b, dims }] : [];
    });
}

function AddStack({
  controller,
  doc,
  onAdd,
}: {
  controller: CadController;
  doc: CadSnapshot['content'];
  onAdd: (s: Omit<CadToleranceStack, 'id'>) => Promise<boolean> | boolean;
}) {
  const L = cadToleranceStackLimits;
  const lengths = doc.parameters.filter((p) => p.type === 'length');
  const pmiBodies = pmiDimensions(controller, doc);
  const [label, setLabel] = useState('');
  const [requirement, setRequirement] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [runs, setRuns] = useState(String(L.defaultRuns));
  const [seed, setSeed] = useState(String(L.defaultSeed));
  const [contributors, setContributors] = useState<CadStackContributor[]>([]);
  // The contributor being written.
  const [cName, setCName] = useState('');
  const [chosenKind, setKind] = useState<'parameter' | 'pmi'>('parameter');
  // The source follows what the document has: PMI when it has no length parameter, and back.
  const kind: 'parameter' | 'pmi' =
    chosenKind === 'pmi'
      ? pmiBodies.length
        ? 'pmi'
        : 'parameter'
      : lengths.length || !pmiBodies.length
        ? 'parameter'
        : 'pmi';
  const [parameterId, setParameterId] = useState(lengths[0]?.id ?? '');
  const [pmiBody, setPmiBody] = useState(pmiBodies[0]?.body.id ?? '');
  const [pmiItem, setPmiItem] = useState('');
  const [lower, setLower] = useState('');
  const [upper, setUpper] = useState('');
  const [sign, setSign] = useState<1 | -1>(1);
  const [distribution, setDistribution] = useState<CadStackDistribution>('normal');
  const lo = parse(lower);
  const hi = parse(upper);
  const chosenBody = pmiBodies.find((x) => x.body.id === pmiBody) ?? pmiBodies[0];
  const chosenItem = chosenBody?.dims.find((d) => d.id === pmiItem) ?? chosenBody?.dims[0];
  const parameter = lengths.find((p) => p.id === parameterId) ?? lengths[0];
  const deviationOk = (v: number | undefined) =>
    v !== undefined && Number.isFinite(v) && Math.abs(v) <= L.deviation;
  const source: CadStackContributor['source'] | undefined =
    kind === 'parameter'
      ? parameter && deviationOk(lo) && deviationOk(hi) && lo! <= hi!
        ? { kind, parameterId: parameter.id, lower: lo!, upper: hi! }
        : undefined
      : chosenBody && chosenItem
        ? { kind, bodyId: chosenBody.body.id, itemId: chosenItem.id }
        : undefined;
  const contributorReady = !!cName.trim() && !!source && contributors.length < L.contributors;
  const addContributor = () => {
    if (!contributorReady) return;
    setContributors([
      ...contributors,
      {
        id: controller.newId('contributor'),
        name: cName.trim(),
        source: source!,
        sign,
        distribution,
      },
    ]);
    setCName('');
    setLower('');
    setUpper('');
  };
  const bMin = parse(min);
  const bMax = parse(max);
  const nRuns = parse(runs);
  const nSeed = parse(seed);
  const bandOk =
    (bMin === undefined || Number.isFinite(bMin)) &&
    (bMax === undefined || Number.isFinite(bMax)) &&
    (bMin === undefined || bMax === undefined || bMin <= bMax);
  const runsOk = nRuns !== undefined && Number.isInteger(nRuns) && nRuns >= 1 && nRuns <= L.runs;
  const seedOk =
    nSeed !== undefined && Number.isInteger(nSeed) && nSeed >= 0 && nSeed <= 0xffffffff;
  const ready = !!label.trim() && contributors.length > 0 && bandOk && runsOk && seedOk;
  const add = async () => {
    if (!ready) return;
    const ok = await onAdd({
      name: label.trim(),
      ...(requirement.trim() ? { requirement: requirement.trim() } : {}),
      contributors,
      ...(bMin !== undefined ? { min: bMin } : {}),
      ...(bMax !== undefined ? { max: bMax } : {}),
      runs: nRuns!,
      seed: nSeed!,
    });
    if (ok) {
      setLabel('');
      setRequirement('');
      setMin('');
      setMax('');
      setContributors([]);
    }
  };
  return (
    <div className="cad-forms" role="group" aria-label="Add tolerance stack">
      <label className="ep-field">
        Stack name
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="ep-field">
        Requirement ID
        <input
          value={requirement}
          placeholder="optional, e.g. RQ-11"
          onChange={(e) => setRequirement(e.target.value)}
        />
      </label>
      <div className="cad-row">
        <label className="ep-field">
          Band min
          <input value={min} inputMode="decimal" onChange={(e) => setMin(e.target.value)} />
        </label>
        <label className="ep-field">
          Band max
          <input value={max} inputMode="decimal" onChange={(e) => setMax(e.target.value)} />
        </label>
      </div>
      <div className="cad-row">
        <label className="ep-field">
          Runs
          <input value={runs} inputMode="numeric" onChange={(e) => setRuns(e.target.value)} />
        </label>
        <label className="ep-field">
          Seed
          <input value={seed} inputMode="numeric" onChange={(e) => setSeed(e.target.value)} />
        </label>
      </div>
      {contributors.length > 0 && (
        <ol className="cad-stack-contributors" aria-label="New stack contributors">
          {contributors.map((x) => (
            <li key={x.id}>
              {x.sign > 0 ? '+' : '−'} {x.name}{' '}
              <span className="cad-muted">({describeSource(doc, x)})</span>{' '}
              <button
                type="button"
                aria-label={`Drop ${x.name}`}
                onClick={() => setContributors(contributors.filter((y) => y.id !== x.id))}
              >
                Drop
              </button>
            </li>
          ))}
        </ol>
      )}
      <fieldset className="cad-forms" aria-label="Contributor">
        <label className="ep-field">
          Contributor name
          <input value={cName} onChange={(e) => setCName(e.target.value)} />
        </label>
        <label className="ep-field">
          Source
          <select value={kind} onChange={(e) => setKind(e.target.value as 'parameter' | 'pmi')}>
            {lengths.length > 0 && <option value="parameter">Parameter</option>}
            {pmiBodies.length > 0 && <option value="pmi">PMI dimension</option>}
          </select>
        </label>
        {kind === 'parameter' ? (
          <>
            <label className="ep-field">
              Parameter
              <select value={parameter?.id ?? ''} onChange={(e) => setParameterId(e.target.value)}>
                {lengths.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="cad-row">
              <label className="ep-field">
                Lower (mm)
                <input
                  value={lower}
                  inputMode="decimal"
                  placeholder="e.g. -0.01"
                  onChange={(e) => setLower(e.target.value)}
                />
              </label>
              <label className="ep-field">
                Upper (mm)
                <input
                  value={upper}
                  inputMode="decimal"
                  placeholder="e.g. 0.01"
                  onChange={(e) => setUpper(e.target.value)}
                />
              </label>
            </div>
          </>
        ) : (
          <>
            <label className="ep-field">
              Body
              <select
                value={chosenBody?.body.id ?? ''}
                onChange={(e) => setPmiBody(e.target.value)}
              >
                {pmiBodies.map((x) => (
                  <option key={x.body.id} value={x.body.id}>
                    {x.body.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="ep-field">
              Dimension
              <select value={chosenItem?.id ?? ''} onChange={(e) => setPmiItem(e.target.value)}>
                {chosenBody?.dims.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id} · {d.values.join('–')} mm
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <div className="cad-row">
          <label className="ep-field">
            Direction
            <select
              value={String(sign)}
              onChange={(e) => setSign(e.target.value === '-1' ? -1 : 1)}
            >
              <option value="1">Adds (+)</option>
              <option value="-1">Subtracts (−)</option>
            </select>
          </label>
          <label className="ep-field">
            Distribution
            <select
              value={distribution}
              onChange={(e) => setDistribution(e.target.value as CadStackDistribution)}
            >
              <option value="normal">Normal (±3σ)</option>
              <option value="uniform">Uniform</option>
            </select>
          </label>
        </div>
        <button type="button" disabled={!contributorReady} onClick={addContributor}>
          Add contributor
        </button>
      </fieldset>
      <button type="button" disabled={!ready} onClick={() => void add()}>
        Add stack
      </button>
    </div>
  );
}
