import { readItems } from '@editor-platform/extension-runtime/items';
// 画面（CSS）を読まない入口だけを使う（#93：tsx の API や Playwright の spec からも読める）
import {
  dataItemsDeclaration,
  type DataItemsDeclaration,
} from '@editor-platform/structured-data/items';
import {
  isStructuredData,
  validateData,
  type Cell,
  type Column,
  type DataRow,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';

export const fmeaTemplateOptions = [
  { id: 'blank', label: 'Blank data table' },
  { id: 'pfmea', label: 'Process FMEA (prototype)' },
  { id: 'dfmea', label: 'Design FMEA (prototype)' },
] as const;

export type FmeaTemplateId = (typeof fmeaTemplateOptions)[number]['id'];
export type FmeaExampleId = Exclude<FmeaTemplateId, 'blank'>;

type FmeaRecord = {
  id: string;
  item: string;
  function: string;
  failure: string;
  effect: string;
  cause: string;
  prevention: string;
  detectionControl: string;
  s: number;
  o: number;
  d: number;
  proposed: string;
  owner: string;
  note: string;
};

/** Example S/O/D values are illustrative and are not evaluated against any industry table. */
const processExample: FmeaRecord[] = [
  {
    id: 'pfmea-001',
    item: '成形工程',
    function: '寸法精度の維持',
    failure: '寸法公差外',
    effect: '組付け不良・手直し',
    cause: '金型温度の変動',
    prevention: '温度設定の標準化',
    detectionControl: '抜取寸法検査',
    s: 7,
    o: 5,
    d: 6,
    proposed: '温度ログ監視と工程能力検証',
    owner: '生産技術',
    note: 'Fishbone: 設備温度の変動（文字列メモ・未リンク）',
  },
  {
    id: 'pfmea-002',
    item: '組立工程',
    function: '部品の確実な固定',
    failure: '締結トルク不足',
    effect: '使用時の緩み・停止',
    cause: 'トルク工具の校正漏れ',
    prevention: '工具点検ルール',
    detectionControl: '締付け記録の監査',
    s: 9,
    o: 3,
    d: 6,
    proposed: '締付け値の自動記録と異常停止',
    owner: '製造',
    note: '校正記録と締付け履歴を確認',
  },
  {
    id: 'pfmea-003',
    item: '外観検査',
    function: '異常品を流出させない',
    failure: '微小傷の見逃し',
    effect: '顧客で外観不良',
    cause: '判定基準の不統一',
    prevention: '検査員の判定訓練',
    detectionControl: '目視と照明治具',
    s: 5,
    o: 6,
    d: 7,
    proposed: '標準画像による判定と抜取監査',
    owner: '品質保証',
    note: '不良画像は未添付',
  },
];

const designExample: FmeaRecord[] = [
  {
    id: 'dfmea-001',
    item: 'ロボット関節 / 減速機',
    function: '指定トルクを伝達',
    failure: '歯面の損傷',
    effect: '関節ロック・動作停止',
    cause: '過大負荷・潤滑不足',
    prevention: '負荷余裕と潤滑設計',
    detectionControl: '寿命試験',
    s: 9,
    o: 4,
    d: 6,
    proposed: '過負荷保護と寿命試験条件の追加',
    owner: '機構設計',
    note: 'FTA基本事象への対応付けは未実装',
  },
  {
    id: 'dfmea-002',
    item: '温度センサー',
    function: '安全温度の検出',
    failure: '値の固定・未更新',
    effect: '過熱状態を見逃す',
    cause: '通信・配線の異常',
    prevention: '配線保護と冗長監視',
    detectionControl: '更新周期の検査',
    s: 10,
    o: 2,
    d: 7,
    proposed: 'Watchdogと異常時の安全停止',
    owner: '電装設計',
    note: '高い重大度をRPNだけで軽視しない',
  },
  {
    id: 'dfmea-003',
    item: '制御ソフトウェア',
    function: '安全範囲内で駆動',
    failure: '停止指令の遅延',
    effect: '停止距離の超過',
    cause: 'タスク競合',
    prevention: '優先度・実行時間の設計',
    detectionControl: 'HIL試験',
    s: 10,
    o: 3,
    d: 5,
    proposed: '最悪実行時間の測定と保護監視',
    owner: '制御設計',
    note: '試験根拠は別成果物で確認する',
  },
];

const columns: Column[] = [
  { id: 'item', name: '対象 / 工程', type: 'text', required: true },
  { id: 'functionRef', name: '要求機能の ID', type: 'text' },
  { id: 'function', name: '要求機能', type: 'text', required: true },
  { id: 'fmId', name: '故障モードの ID', type: 'text' },
  { id: 'failure', name: '故障モード', type: 'text', required: true },
  { id: 'effect', name: '故障影響', type: 'text', required: true },
  { id: 'fcId', name: '故障原因の ID', type: 'text' },
  { id: 'cause', name: '故障原因', type: 'text', required: true },
  { id: 'prevention', name: '予防管理', type: 'text' },
  { id: 'detectionControl', name: '検出管理', type: 'text' },
  { id: 's', name: 'S', type: 'number', required: true },
  { id: 'o', name: 'O', type: 'number', required: true },
  { id: 'd', name: 'D', type: 'number', required: true },
  { id: 'rpn', name: 'RPN（参考）', type: 'formula', formula: 'S * O * D' },
  {
    id: 'ap',
    name: 'AP（要評価）',
    type: 'select',
    options: ['未評価', 'H', 'M', 'L'],
    defaultValue: '未評価',
  },
  { id: 'action', name: '推奨対策', type: 'text' },
  { id: 'owner', name: '担当', type: 'text' },
  { id: 'due', name: '期限', type: 'date' },
  {
    id: 'status',
    name: '対応状態',
    type: 'select',
    options: ['未着手', '対応中', '検証待ち', '完了'],
    defaultValue: '未着手',
  },
  { id: 'evidence', name: '根拠・参照メモ', type: 'text' },
];

/**
 * Analysis items of the FMEA (docs/analysis-references-design.md U1・U2・U6): one row is one
 * failure cause; failure modes are projected many-to-one from rows with the same ID, which must
 * agree on the failure mode, its effect, S and the required function. A row may cite several
 * cause candidates of a cause diagram in its reference field `causeCandidates`. Rows whose ID
 * cells are empty are not items.
 */
export const fmeaItems: DataItemsDeclaration[] = [
  {
    kind: 'failure-cause',
    id: 'fcId',
    title: 'cause',
    refs: ['fmId', 'refs.causeCandidates'],
    labels: { 'refs.causeCandidates': '原因の候補' },
  },
  {
    kind: 'failure-mode',
    id: 'fmId',
    title: 'failure',
    refs: ['functionRef'],
    merge: { equal: ['failure', 'effect', 's', 'function'] },
  },
];

function asRow(record: FmeaRecord): DataRow {
  const values: Record<string, Cell> = {
    item: record.item,
    functionRef: null,
    function: record.function,
    fmId: null,
    failure: record.failure,
    effect: record.effect,
    fcId: null,
    cause: record.cause,
    prevention: record.prevention,
    detectionControl: record.detectionControl,
    s: record.s,
    o: record.o,
    d: record.d,
    ap: '未評価',
    action: record.proposed,
    owner: record.owner,
    due: null,
    status: '未着手',
    evidence: record.note,
  };
  return { id: record.id, values };
}

/**
 * A Host-owned Data template, not a separate FMEA kind. The normal Data grid remains the editor,
 * and no proprietary Action Priority lookup table or cross-Artifact reference is fabricated.
 */
export function createFmeaData(which: FmeaExampleId): StructuredData {
  const records = which === 'pfmea' ? processExample : designExample;
  const data: StructuredData = {
    schemaVersion: 3,
    columns: columns.map((column) => ({
      ...column,
      ...(column.options ? { options: [...column.options] } : {}),
    })),
    rows: records.map(asRow),
    items: structuredClone(fmeaItems),
  };
  const base = defaultView(data);
  const widths = {
    item: 180,
    functionRef: 120,
    function: 180,
    fmId: 120,
    failure: 180,
    effect: 200,
    fcId: 120,
    cause: 200,
    prevention: 180,
    detectionControl: 180,
    s: 90,
    o: 90,
    d: 90,
    rpn: 130,
    ap: 135,
    action: 220,
    owner: 130,
    due: 115,
    status: 120,
    evidence: 250,
  };
  data.views = [
    { ...base, id: 'fmea-risk', name: 'リスク分析', frozen: 3, widths },
    {
      ...base,
      id: 'fmea-action',
      name: '対策管理',
      frozen: 2,
      groupBy: 'status',
      widths,
      hidden: ['functionRef', 'function', 'fmId', 'prevention', 'detectionControl'],
    },
  ];
  return data;
}

/**
 * A conservative marker for the prototype: the template's stable column IDs, with RPN as a
 * formula. Column names and the formula text may be edited without losing the rating checks;
 * columns a user adds get generated IDs, so ordinary Data does not match by accident.
 */
export function isFmeaData(data: StructuredData): boolean {
  return (
    ['failure', 'effect', 'cause', 's', 'o', 'd', 'rpn', 'ap', 'action', 'status'].every((id) =>
      data.columns.some((column) => column.id === id),
    ) && data.columns.some((column) => column.id === 'rpn' && column.type === 'formula')
  );
}

export interface FmeaInspection {
  issues: string[];
  apPending: number;
  rowCount: number;
}

/**
 * Detects invalid ratings even though generic Structured Data only enforces numeric cell type.
 * A valid RPN does not validate the FMEA method or prove an AP category.
 */
export function inspectFmeaData(data: StructuredData): FmeaInspection {
  const issues: string[] = [];
  if (!isStructuredData(data) || !isFmeaData(data)) {
    return { rowCount: 0, apPending: 0, issues: ['FMEAテンプレートの形式を確認できません。'] };
  }
  issues.push(...validateData(data).map((e) => e.rowId + ' / ' + e.columnId + ': ' + e.message));
  let apPending = 0;
  for (const row of data.rows) {
    for (const rating of ['s', 'o', 'd']) {
      const value = row.values[rating];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10)
        issues.push(row.id + ' / ' + rating.toUpperCase() + ': 1～10の整数が必要です。');
    }
    if (row.values.ap === '未評価' || row.values.ap == null) apPending++;
  }
  issues.push(...fmeaItemIssues(data));
  return { rowCount: data.rows.length, apPending, issues };
}

/** The name and content a new FMEA Data Artifact starts with. */
export function createFmeaArtifact(which: FmeaExampleId): {
  name: string;
  content: StructuredData;
} {
  return {
    name: which === 'pfmea' ? 'PFMEA: 製造工程（試作）' : 'DFMEA: 製品設計（試作）',
    content: createFmeaData(which),
  };
}

/**
 * Diagnostics for the declared items: an ID used by two rows of a kind without a merge, or a
 * failure mode whose rows disagree on a compared column (「FM-03 の故障影響が行ごとに違う」).
 * The user fixes them; nothing is aligned automatically. Empty when the table declares no items.
 */
export function fmeaItemIssues(data: StructuredData): string[] {
  const declaration = dataItemsDeclaration(data);
  if (!declaration) return [];
  const read = readItems(declaration, data, () => undefined);
  const name = (path: string) =>
    path.startsWith('values.')
      ? (data.columns.find((c) => c.id === path.slice(7))?.name ?? path)
      : path;
  const rowsOf = (d: { elements: readonly { key: string }[] }) =>
    d.elements.map((e) => data.rows[Number(e.key)]?.id ?? e.key).join('・');
  return [
    ...read.problems,
    ...(read.duplicates ?? []).map((d) =>
      d.reason === 'merge-mismatch'
        ? `${d.id} の${(d.paths ?? []).map(name).join('・')}が行ごとに違います（${rowsOf(d)}）。`
        : `${d.id} が複数の行にあります（${rowsOf(d)}）。`,
    ),
  ];
}
