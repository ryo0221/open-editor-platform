import { validate } from './schema-validator.mjs';

export function check(def) {
  if (!validate(def)) return validate.errors.map(e => `${e.instancePath || '/'}: ${e.message}${e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
  return checkSemantics(def);
}

const ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const CHECKERS = ['人', 'AI'];

const HEX = /^#[0-9a-fA-F]{6}$/;
const kindsOf = (secs) => (secs ?? []).flatMap((s) => [...(s.item ? [s.item] : []), ...kindsOf(s.children)]);
// 成果物の見せ方。図・カンバン・タイムライン・カレンダー・表・フォーム・マトリクスを 1 つか配列で（as ごとに 1 つまで）。種類はその成果物の見出しの項目
const AS = 'graph・kanban・timeline・calendar・table・form・matrix';
function viewProblems(d, def) {
  const list = Array.isArray(d.view) ? d.view : [d.view];
  if (!list.length) return ['の配列が空'];
  const out = [], as = new Set(), own = new Set(kindsOf(d.outline));
  const check = { graph: graphProblems, kanban: kanbanProblems, timeline: timelineProblems, calendar: calendarProblems, table: tableProblems, form: formProblems, matrix: matrixProblems };
  list.forEach((v, i) => {
    const at = Array.isArray(d.view) ? `[${i}]` : '';
    const ps = v && typeof v === 'object' && typeof v.as === 'string' && Object.hasOwn(check, v.as) ? check[v.as](v, own, def) : [`の as は ${AS} のどれか`];
    out.push(...ps.map((m) => `${at}${m}`));
    if (v && typeof v === 'object' && typeof v.as === 'string') { if (as.has(v.as)) out.push(`の as ${v.as} が 2 つある`); as.add(v.as); }
  });
  return out;
}
const unknownKeys = (v, keys) => Object.keys(v).filter((k) => !keys.includes(k)).map((k) => `の知らない欄: ${k}`);
const fieldName = (v, k, need) => ((v[k] === undefined && !need) || (typeof v[k] === 'string' && v[k] !== '') ? [] : [`の ${k} は欄の名前`]);
const itemsOf = (v, own) => (typeof v.items !== 'string' || !v.items ? ['の items は項目の種類'] : own.has(v.items) ? [] : [`の items の ${v.items} は、この成果物の項目の種類に無い`]);
const strings = (v, k) => (v[k] === undefined || (Array.isArray(v[k]) && v[k].every((x) => typeof x === 'string' && x)) ? [] : [`の ${k} は文字の配列`]);
function graphProblems(v, own) {
  const out = unknownKeys(v, ['as', 'nodes', 'edges', 'sections', 'colorBy', 'colors', 'edgeColorBy', 'edgeColors']), seen = new Set();
  for (const k of ['nodes', 'edges', 'sections']) {
    const ks = v[k];
    if (ks === undefined && k !== 'nodes') continue;
    if (!Array.isArray(ks) || (k === 'nodes' && !ks.length)) { out.push(`の ${k} は項目の種類の配列`); continue; }
    for (const x of ks) {
      if (!own.has(x)) out.push(`の ${k} の ${x} は、この成果物の項目の種類に無い`);
      if (seen.has(x)) out.push(`の ${x} が点・線・枠に重なっている`);
      seen.add(x);
    }
  }
  for (const k of ['colorBy', 'edgeColorBy']) out.push(...fieldName(v, k, false));
  for (const k of ['colors', 'edgeColors']) {
    const c = v[k];
    if (c === undefined) continue;
    if (!c || typeof c !== 'object' || Array.isArray(c)) { out.push(`の ${k} は値 → 色`); continue; }
    for (const [x, col] of Object.entries(c)) if (typeof col !== 'string' || !HEX.test(col)) out.push(`の ${k} の ${x} の色は #rrggbb`);
  }
  if (v.colors && !v.colorBy) out.push('の colors には colorBy が要る');
  if (v.edgeColors && !v.edgeColorBy) out.push('の edgeColors には edgeColorBy が要る');
  return out;
}
const kanbanProblems = (v, own) => [...unknownKeys(v, ['as', 'items', 'groupBy', 'columns', 'card']), ...itemsOf(v, own), ...fieldName(v, 'groupBy', true), ...strings(v, 'columns'), ...strings(v, 'card')];
const timelineProblems = (v, own) => [...unknownKeys(v, ['as', 'items', 'start', 'end', 'groupBy', 'scale']), ...itemsOf(v, own), ...fieldName(v, 'start', true), ...fieldName(v, 'end', true), ...fieldName(v, 'groupBy', false),
  ...(v.scale === undefined || ['day', 'week', 'month'].includes(v.scale) ? [] : ['の scale は day・week・month のどれか'])];

const calendarProblems = (v, own) => [...unknownKeys(v, ['as', 'items', 'date', 'end']), ...itemsOf(v, own), ...fieldName(v, 'date', true), ...fieldName(v, 'end', false)];
const sortProblems = (s) => (s === undefined ? [] : !Array.isArray(s) ? ['の sort は配列']
  : s.flatMap((x, i) => (!x || typeof x !== 'object' || Array.isArray(x) ? [`の sort[${i}] は { by, desc }`]
    : [...unknownKeys(x, ['by', 'desc']).map((m) => `の sort[${i}] の${m.slice(1)}`), ...(typeof x.by === 'string' && x.by ? [] : [`の sort[${i}] の by は欄の名前`]), ...(x.desc === undefined || typeof x.desc === 'boolean' ? [] : [`の sort[${i}] の desc は true か false`])])));
const tableProblems = (v, own) => [...unknownKeys(v, ['as', 'items', 'columns', 'sort', 'groupBy', 'hide']), ...itemsOf(v, own), ...strings(v, 'columns'), ...sortProblems(v.sort), ...fieldName(v, 'groupBy', false), ...strings(v, 'hide')];
const formProblems = (v, own) => [...unknownKeys(v, ['as', 'items', 'fields']), ...itemsOf(v, own), ...strings(v, 'fields')];
// 行はこの成果物の項目、列は定義のどの項目でもよい。行と列のあいだには、どちら向きかの引用の規則が要る
function matrixProblems(v, own, def) {
  const out = unknownKeys(v, ['as', 'rows', 'columns']), all = new Set((def.items ?? []).map((x) => x.id));
  out.push(...itemsOf({ items: v.rows }, own).map((m) => m.replace('items', 'rows')));
  if (typeof v.columns !== 'string' || !v.columns) out.push('の columns は項目の種類');
  else if (!all.has(v.columns)) out.push(`の columns の ${v.columns} は items に無い`);
  const cites = (a, b) => (def.rules ?? []).some((r) => r.type === 'cites' && r.from === a && (r.to ?? []).includes(b));
  if (!out.length && !cites(v.rows, v.columns) && !cites(v.columns, v.rows)) out.push(`の ${v.rows} と ${v.columns} のあいだに引用の規則が無い`);
  return out;
}

function checkSemantics(def) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(def.format === 1, 'format は 1');
  for (const k of ['id', 'version', 'title', 'purpose']) need(typeof def[k] === 'string' && def[k].length > 0, `${k} が無い`);
  need(ID.test(def.id ?? ''), `id の形が違う: ${def.id}`);
  need(/^\d+\.\d+\.\d+$/.test(def.version ?? ''), `version の形が違う: ${def.version}`);
  const allowed = new Set(['format', 'id', 'version', 'title', 'purpose', 'phases', 'sections', 'deliverables', 'items', 'rules', 'strictCites', 'roles', 'acceptance', 'gates', 'placements']);
  for (const k of Object.keys(def)) need(allowed.has(k), `知らない欄: ${k}`);

  const phases = def.phases ?? [], sections = def.sections ?? [], deliverables = def.deliverables ?? [], acceptance = def.acceptance ?? [];
  const ids = new Set();
  for (const x of [...phases, ...sections, ...deliverables, ...acceptance]) {
    need(ID.test(x.id ?? ''), `id の形が違う: ${x.id}`);
    need(!ids.has(x.id), `id が重なっている: ${x.id}`);
    ids.add(x.id);
  }
  const P = new Set(phases.map((p) => p.id)), D = new Set(deliverables.map((d) => d.id)), A = new Set(acceptance.map((a) => a.id));
  const items = def.items ?? [], rules = def.rules ?? [];
  const I = new Set(), R = new Set(), marked = new Map();
  for (const it of items) {
    need(ID.test(it.id ?? ''), `項目の種類の id の形が違う: ${it.id}`);
    need(!I.has(it.id), `項目の種類が重なっている: ${it.id}`);
    I.add(it.id);
    need(typeof it.idForm === 'string' && /\{(nnn|nn|n)\}/.test(it.idForm), `項目 ${it.id}: idForm に連番が無い`);
    need(!it.idForm?.includes('{parent}') || !!it.parent, `項目 ${it.id}: idForm に {parent} があるのに parent が無い`);
  }
  for (const it of items) if (it.parent) need(I.has(it.parent), `項目 ${it.id}: 親 ${it.parent} が無い`);
  const forms = items.filter((it) => !it.parent).map((it) => it.idForm);
  need(new Set(forms).size === forms.length, '親の無い項目の idForm が重なっている');
  for (const r of rules) {
    need(ID.test(r.id ?? '') && !R.has(r.id), `規則の id が違うか重なっている: ${r.id}`);
    R.add(r.id);
    if (r.type === 'cites') {
      need(I.has(r.from), `規則 ${r.id}: from ${r.from} が無い`);
      need((r.to ?? []).length > 0 && r.to.every((t) => I.has(t)), `規則 ${r.id}: to に無い項目がある`);
      need(Number.isInteger(r.min) && r.min >= 0, `規則 ${r.id}: min は 0 以上`);
    } else if (r.type === 'covered') {
      need(I.has(r.of), `規則 ${r.id}: of ${r.of} が無い`);
      need((r.by ?? []).length > 0 && r.by.every((t) => I.has(t)), `規則 ${r.id}: by に無い項目がある`);
    } else problems.push(`規則 ${r.id}: type は cites・covered のどれか`);
  }
  // strictCites：規則に無い組の引用を使う側が違反にする。許す組が無いと、どの引用も違反になる
  need(def.strictCites === undefined || def.strictCites === true, 'strictCites は true だけ（書かなければ使う側に任せる）');
  need(def.strictCites === undefined || rules.some((r) => r.type === 'cites'), 'strictCites には cites 規則が要る');
  // 引用は from→to の組だけを持ち、規則の ID を持たない。同じ組を二つの規則が許すと、引用がどちらの意味かが決まらない
  const pairs = new Map();
  for (const r of rules) {
    if (r.type !== 'cites' || typeof r.from !== 'string' || !Array.isArray(r.to)) continue;
    for (const t of new Set(r.to)) {
      const k = `${r.from}\u0000${t}`, had = pairs.get(k);
      if (had === undefined) pairs.set(k, r.id);
      else if (had !== r.id) problems.push(`規則 ${had} と ${r.id}: 同じ組 ${r.from} → ${t} の引用を許している（組ごとに規則は 1 つ）`);
    }
  }

  for (const p of phases) {
    for (const k of ['name', 'purpose']) need(typeof p[k] === 'string' && p[k], `工程 ${p.id}: ${k} が無い`);
    for (const a of p.after ?? []) need(P.has(a), `工程 ${p.id}: after の ${a} が無い`);
    need((p.deliverables ?? []).length > 0, `工程 ${p.id}: 成果物が無い`);
    need((p.acceptance ?? []).length > 0, `工程 ${p.id}: 達成条件が無い`);
    for (const d of p.deliverables ?? []) need(D.has(d), `工程 ${p.id}: 成果物 ${d} が無い`);
    for (const a of p.acceptance ?? []) need(A.has(a), `工程 ${p.id}: 達成条件 ${a} が無い`);
    for (const a of p.acceptance ?? []) {
      const t = acceptance.find((x) => x.id === a)?.target;
      need(!t || (p.deliverables ?? []).includes(t), `工程 ${p.id}: 達成条件 ${a} の対象 ${t} がこの工程の成果物でない`);
    }
  }
  for (const d of deliverables) {
    need(typeof d.form === 'string' && d.form.trim().length > 0, `成果物 ${d.id}: form は空でない文字列`);
    need((d.outline ?? []).length > 0, `成果物 ${d.id}: outline が無い`);
    const walk = (secs, depth) => {
      need(depth <= 4, `成果物 ${d.id}: 見出しが 4 段より深い`);
      const seen = new Set();
      for (const s of secs ?? []) {
        need(typeof s.heading === 'string' && s.heading && typeof s.describe === 'string' && s.describe, `成果物 ${d.id}: 見出しに heading と describe が要る`);
        need(!seen.has(s.heading), `成果物 ${d.id}: 同じ段で見出しが重なっている: ${s.heading}`);
        seen.add(s.heading);
        for (const k of Object.keys(s)) need(['heading', 'describe', 'item', 'repeat', 'children'].includes(k), `成果物 ${d.id}: 見出しの知らない欄: ${k}`);
        if (s.item) { need(I.has(s.item), `成果物 ${d.id}: 見出し ${s.heading} の項目 ${s.item} が items に無い`); marked.set(s.item, (marked.get(s.item) ?? 0) + 1); }
        if (s.children) walk(s.children, depth + 1);
      }
    };
    walk(d.outline, 1);
    for (const u of d.uses ?? []) need(D.has(u), `成果物 ${d.id}: uses の ${u} が無い`);
    if (d.view !== undefined) for (const m of viewProblems(d, def)) need(false, `成果物 ${d.id}: view ${m}`);
    need(phases.some((p) => (p.deliverables ?? []).includes(d.id)), `成果物 ${d.id}: どの工程も作らない`);
  }
  for (const it of items) need(marked.get(it.id) === 1, `項目 ${it.id}: どれか一つの見出しに item として置く（今 ${marked.get(it.id) ?? 0} か所）`);
  for (const a of acceptance) for (const r of a.rules ?? []) need(R.has(r), `達成条件 ${a.id}: 規則 ${r} が無い`);
  const roles = def.roles ?? [], RO = new Set();
  for (const r of roles) {
    need(ID.test(r?.id ?? '') && !RO.has(r?.id), `役割の id が違うか重なっている: ${r?.id}`);
    RO.add(r?.id);
    need(typeof r?.name === 'string' && r.name.length > 0, `役割 ${r?.id}: name が無い`);
  }
  for (const a of acceptance) {
    if (a.approvers === undefined) continue;
    need(a.checkedBy === '人', `達成条件 ${a.id}: approvers は人の条件にだけ書ける`);
    const rs = a.approvers?.roles;
    need(Array.isArray(rs) && rs.length > 0, `達成条件 ${a.id}: approvers に roles が無い`);
    for (const r of Array.isArray(rs) ? rs : []) need(RO.has(r), `達成条件 ${a.id}: 役割 ${r} が無い`);
    need(Array.isArray(rs) && new Set(rs).size === rs.length, `達成条件 ${a.id}: approvers の roles が重なっている`);
    const n = a.approvers?.count;
    need(n === undefined || (Number.isInteger(n) && n >= 1), `達成条件 ${a.id}: approvers の count は 1 以上の整数`);
  }
  for (const r of roles) need(acceptance.some((a) => (a.approvers?.roles ?? []).includes(r?.id)), `役割 ${r?.id}: どの達成条件でも使われていない`);
  for (const a of acceptance) {
    need(CHECKERS.includes(a.checkedBy), `達成条件 ${a.id}: checkedBy は 人・AI のどれか`);
    need(D.has(a.target), `達成条件 ${a.id}: 対象 ${a.target} が無い`);
    need(phases.some((p) => (p.acceptance ?? []).includes(a.id)), `達成条件 ${a.id}: どの工程でも使われていない`);
  }
  for (const p of phases) {
    const human = (p.acceptance ?? []).some((a) => acceptance.find((x) => x.id === a)?.checkedBy === '人');
    need(human, `工程 ${p.id}: 人が確かめる達成条件が無い`);
  }
  // 工程のまとまり：どの工程もちょうど 1 つに入り、並びは工程の順に従う
  if (def.sections !== undefined) {
    const at = new Map();
    sections.forEach((s, si) => {
      need(typeof s.name === 'string' && s.name, `まとまり ${s.id}: name が無い`);
      need((s.phases ?? []).length > 0, `まとまり ${s.id}: 工程が無い`);
      (s.phases ?? []).forEach((p, pi) => {
        need(P.has(p), `まとまり ${s.id}: 工程 ${p} が無い`);
        need(!at.has(p), `工程 ${p}: 2 つ以上のまとまりに入っている`);
        if (!at.has(p)) at.set(p, [si, pi]);
      });
    });
    for (const p of phases) {
      need(at.has(p.id), `工程 ${p.id}: どのまとまりにも入っていない`);
      const [si, pi] = at.get(p.id) ?? [];
      for (const a of p.after ?? []) {
        const [sa, pa] = at.get(a) ?? [];
        if (si !== undefined && sa !== undefined) need(sa < si || (sa === si && pa < pi), `工程 ${p.id}: 先に終える ${a} が、まとまりの並びで後ろにある`);
      }
    }
  }
  // 既定のゲート：名前は重ならず、流す工程は phases にある
  const gateNames = new Set();
  for (const g of def.gates ?? []) {
    need(!gateNames.has(g.name), `ゲートの名前が重なっている: ${g.name}`);
    gateNames.add(g.name);
    for (const p of g.phases ?? []) need(P.has(p), `ゲート ${g.name}: 工程 ${p} が無い`);
  }
  // 置き場所の形：ID は重ならず、ゲートは定義のゲートと同じ決まり、paths は成果物の ID
  const placementIds = new Set();
  for (const pl of def.placements ?? []) {
    need(!placementIds.has(pl.id), `置き場所の形の ID が重なっている: ${pl.id}`);
    placementIds.add(pl.id);
    const names = new Set();
    for (const g of pl.gates ?? []) {
      need(!names.has(g.name), `置き場所の形 ${pl.id}: ゲートの名前が重なっている: ${g.name}`);
      names.add(g.name);
      for (const p of g.phases ?? []) need(P.has(p), `置き場所の形 ${pl.id}: ゲート ${g.name}: 工程 ${p} が無い`);
    }
    for (const d of Object.keys(pl.paths ?? {})) need(D.has(d), `置き場所の形 ${pl.id}: 成果物 ${d} が無い`);
  }
  // 工程の順の循環
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { problems.push(`工程の順が循環している: ${[...path, id].join(' → ')}`); return; }
    state.set(id, 1);
    for (const a of phases.find((p) => p.id === id)?.after ?? []) visit(a, [...path, id]);
    state.set(id, 2);
  };
  for (const p of phases) visit(p.id, []);
  return problems;
}

