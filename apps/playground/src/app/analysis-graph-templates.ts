import {
  createGraph,
  validateGraph,
  type GraphDocument,
  type GraphNode,
  type GraphProfile,
} from '@editor-platform/structured-graph/model';

/**
 * Experimental analysis-specific Graph profiles. They deliberately reuse the existing Graph
 * model and editor instead of introducing new Artifact kinds or a second persistence path.
 * Neither profile is an industry-standard certified analysis implementation.
 */
export const fishboneProfile: GraphProfile = {
  schemaVersion: 2,
  id: 'analysis-fishbone',
  version: 1,
  graph: {
    schema: {
      title: { type: 'string', required: true },
      notes: { type: 'string' },
    },
    ui: {
      order: ['title', 'notes'],
      fields: { title: { label: '問題' }, notes: { label: '前提' } },
    },
  },
  nodes: {
    problem: {
      schema: {
        name: { type: 'string', required: true },
        metric: { type: 'string' },
      },
      ui: {
        label: '分析対象の問題',
        group: 'フィッシュボーン',
        shape: 'rounded-rectangle',
        style: { fill: '#fee2e2' },
        labelField: 'name',
        order: ['name', 'metric'],
        fields: { name: { label: '問題' }, metric: { label: '指標' } },
      },
    },
    category: {
      schema: { name: { type: 'string', required: true } },
      ui: {
        label: '原因の分類',
        group: 'フィッシュボーン',
        shape: 'hexagon',
        style: { fill: '#dbeafe' },
        labelField: 'name',
        order: ['name'],
        fields: { name: { label: '分類名' } },
      },
    },
    cause: {
      schema: {
        name: { type: 'string', required: true },
        status: { type: 'enum', enum: ['candidate', 'confirmed', 'excluded'] },
        evidence: { type: 'string' },
      },
      ui: {
        label: '原因候補',
        group: 'フィッシュボーン',
        shape: 'rounded-rectangle',
        style: { fill: '#fef3c7' },
        labelField: 'name',
        order: ['name', 'status', 'evidence'],
        fields: {
          name: { label: '原因' },
          status: {
            label: '調査状態',
            options: [
              { value: 'candidate', label: '仮説' },
              { value: 'confirmed', label: '確認済み' },
              { value: 'excluded', label: '除外' },
            ],
          },
          evidence: { label: '根拠・参照' },
        },
      },
    },
  },
  edges: {
    contributes: {
      schema: { rationale: { type: 'string' } },
      ui: {
        label: '原因のつながり',
        order: ['rationale'],
        fields: { rationale: { label: '説明' } },
      },
      connection: {
        from: ['cause', 'category'],
        to: ['cause', 'category', 'problem'],
        allowSelf: false,
        allowParallel: false,
        allowCycles: false,
      },
    },
  },
  sections: {},
};

export const ftaProfile: GraphProfile = {
  schemaVersion: 2,
  id: 'analysis-fault-tree',
  version: 1,
  graph: {
    schema: {
      title: { type: 'string', required: true },
      assumptions: { type: 'string' },
    },
    ui: {
      order: ['title', 'assumptions'],
      fields: {
        title: { label: 'トップ事象' },
        assumptions: { label: '計算の仮定' },
      },
    },
  },
  nodes: {
    top: {
      schema: { name: { type: 'string', required: true } },
      ui: {
        label: 'トップ事象',
        group: 'FTA',
        shape: 'rounded-rectangle',
        style: { fill: '#fee2e2' },
        labelField: 'name',
      },
    },
    basic: {
      schema: {
        name: { type: 'string', required: true },
        probability: { type: 'number', required: true, minimum: 0, maximum: 1 },
        evidence: { type: 'string' },
      },
      ui: {
        label: '基本事象',
        group: 'FTA',
        shape: 'ellipse',
        style: { fill: '#dbeafe' },
        labelField: 'name',
        order: ['name', 'probability', 'evidence'],
        fields: {
          name: { label: '故障事象' },
          probability: { label: '発生確率 (0～1)' },
          evidence: { label: '根拠' },
        },
      },
    },
    and: {
      schema: { name: { type: 'string', required: true } },
      ui: {
        label: 'ANDゲート',
        group: 'FTA',
        shape: 'hexagon',
        style: { fill: '#dcfce7' },
        labelField: 'name',
      },
    },
    or: {
      schema: { name: { type: 'string', required: true } },
      ui: {
        label: 'ORゲート',
        group: 'FTA',
        shape: 'hexagon',
        style: { fill: '#fef3c7' },
        labelField: 'name',
      },
    },
  },
  edges: {
    input: {
      schema: {},
      ui: { label: '論理入力' },
      connection: {
        from: ['basic', 'and', 'or'],
        to: ['and', 'or', 'top'],
        allowSelf: false,
        allowParallel: false,
        allowCycles: false,
      },
    },
  },
  sections: {},
};

type PositionedNode = GraphNode & { x: number; y: number };

function example(
  profile: GraphProfile,
  title: string,
  nodes: PositionedNode[],
  links: [string, string][],
): GraphDocument {
  const graph = createGraph({ id: profile.id, version: profile.version });
  graph.attributes = { title };
  graph.nodes = nodes.map(({ id, type, attributes }) => ({ id, type, attributes }));
  graph.edges = links.map(([from, to], index) => ({
    id: 'link-' + String(index + 1),
    type: profile.id === ftaProfile.id ? 'input' : 'contributes',
    from,
    to,
    attributes: {},
  }));
  graph.presentation.nodes = Object.fromEntries(nodes.map(({ id, x, y }) => [id, { x, y }]));
  return graph;
}

/** Layout approximates a cause-and-effect map; no custom fishbone renderer is introduced. */
export function createFishboneGraph(): GraphDocument {
  return example(
    fishboneProfile,
    '製品の不良率が上昇',
    [
      {
        id: 'problem',
        type: 'problem',
        attributes: { name: '製品の不良率が上昇', metric: '不良率' },
        x: 1190,
        y: 335,
      },
      { id: 'equipment', type: 'category', attributes: { name: '設備' }, x: 835, y: 110 },
      { id: 'people', type: 'category', attributes: { name: '人' }, x: 835, y: 575 },
      { id: 'method', type: 'category', attributes: { name: '方法' }, x: 480, y: 110 },
      { id: 'material', type: 'category', attributes: { name: '材料' }, x: 480, y: 575 },
      {
        id: 'temperature',
        type: 'cause',
        attributes: {
          name: '設備温度の変動',
          status: 'candidate',
          evidence: '温度ログを確認する',
        },
        x: 160,
        y: 25,
      },
      {
        id: 'calibration',
        type: 'cause',
        attributes: {
          name: 'センサー校正の不足',
          status: 'candidate',
        },
        x: 160,
        y: 150,
      },
      {
        id: 'instructions',
        type: 'cause',
        attributes: {
          name: '作業指示の曖昧さ',
          status: 'candidate',
        },
        x: 160,
        y: 290,
      },
      {
        id: 'training',
        type: 'cause',
        attributes: {
          name: '教育の不足',
          status: 'candidate',
        },
        x: 160,
        y: 435,
      },
      {
        id: 'inspection',
        type: 'cause',
        attributes: {
          name: '検査手順のばらつき',
          status: 'candidate',
        },
        x: 160,
        y: 575,
      },
      {
        id: 'lots',
        type: 'cause',
        attributes: {
          name: '材料ロット差',
          status: 'candidate',
        },
        x: 160,
        y: 700,
      },
    ],
    [
      ['temperature', 'equipment'],
      ['calibration', 'equipment'],
      ['instructions', 'method'],
      ['training', 'people'],
      ['inspection', 'method'],
      ['lots', 'material'],
      ['equipment', 'problem'],
      ['people', 'problem'],
      ['method', 'problem'],
      ['material', 'problem'],
    ],
  );
}

export function createFtaGraph(): GraphDocument {
  const graph = example(
    ftaProfile,
    '設備停止のFTA（独立事象の例）',
    [
      { id: 'top', type: 'top', attributes: { name: '設備が停止' }, x: 600, y: 45 },
      { id: 'gate-or', type: 'or', attributes: { name: 'OR' }, x: 600, y: 215 },
      {
        id: 'power',
        type: 'basic',
        attributes: {
          name: '電源故障',
          probability: 0.01,
          evidence: '説明用の仮定値',
        },
        x: 300,
        y: 395,
      },
      {
        id: 'controller',
        type: 'basic',
        attributes: {
          name: '制御装置故障',
          probability: 0.02,
          evidence: '説明用の仮定値',
        },
        x: 900,
        y: 395,
      },
    ],
    [
      ['power', 'gate-or'],
      ['controller', 'gate-or'],
      ['gate-or', 'top'],
    ],
  );
  graph.attributes.assumptions = '基本事象の独立性を仮定。共通原因故障・時間依存を扱わない。';
  return graph;
}

export type FtaResult =
  | { ok: true; probability: number; topId: string; basicEventIds: string[] }
  | { ok: false; issues: string[] };

/**
 * Illustrative static FTA evaluation only. A repeated leaf is rejected rather than incorrectly
 * treating two dependent branches as independent. No evidence verifies independence for users.
 */
export function evaluateFta(graph: GraphDocument): FtaResult {
  if (graph.profile.id !== ftaProfile.id || graph.profile.version !== ftaProfile.version)
    return { ok: false, issues: ['FTAのProfileではありません。'] };
  const diagnostics = validateGraph(graph, ftaProfile).filter((item) => item.blocking);
  if (diagnostics.length) return { ok: false, issues: diagnostics.map((item) => item.message) };
  const tops = graph.nodes.filter((node) => node.type === 'top');
  if (tops.length !== 1) return { ok: false, issues: ['トップ事象を1つ指定してください。'] };
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const inputs = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of graph.edges) inputs.get(edge.to)?.push(edge.from);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const top = tops[0];

  const evaluate = (id: string): { probability: number; leaves: Set<string> } => {
    if (visiting.has(id)) throw Error('FTAに循環があります。');
    const node = byId.get(id);
    if (!node) throw Error('FTAの参照先がありません。');
    visiting.add(id);
    visited.add(id);
    try {
      const children = inputs.get(id) ?? [];
      if (node.type === 'basic') {
        if (children.length) throw Error('基本事象には入力を接続できません。');
        const probability = node.attributes.probability;
        if (
          typeof probability !== 'number' ||
          !Number.isFinite(probability) ||
          probability < 0 ||
          probability > 1
        )
          throw Error('基本事象の発生確率は0～1の数値で指定してください。');
        return { probability, leaves: new Set([id]) };
      }
      if (node.type === 'top' ? children.length !== 1 : children.length < 2)
        throw Error('トップ事象には入力を1つ、AND/ORゲートには2つ以上接続してください。');
      const results = children.map((child) => evaluate(child));
      const leaves = new Set<string>();
      for (const result of results)
        for (const leaf of result.leaves) {
          if (leaves.has(leaf))
            throw Error('同じ基本事象が複数の枝にあります。独立として計算できません。');
          leaves.add(leaf);
        }
      if (node.type === 'top') return { probability: results[0].probability, leaves };
      if (node.type === 'and')
        return { probability: results.reduce((p, part) => p * part.probability, 1), leaves };
      if (node.type === 'or')
        return {
          probability: 1 - results.reduce((q, part) => q * (1 - part.probability), 1),
          leaves,
        };
      throw Error('未知のFTA事象種別です。');
    } finally {
      visiting.delete(id);
    }
  };
  try {
    if (graph.edges.some((edge) => edge.from === top.id))
      throw Error('トップ事象は他の事象に入力できません。');
    const evaluated = evaluate(top.id);
    if (visited.size !== graph.nodes.length)
      throw Error('トップ事象につながっていないノードがあります。');
    return {
      ok: true,
      probability: Math.min(1, Math.max(0, evaluated.probability)),
      topId: top.id,
      basicEventIds: [...evaluated.leaves].sort(),
    };
  } catch (error) {
    return {
      ok: false,
      issues: [error instanceof Error ? error.message : 'FTAを評価できません。'],
    };
  }
}
