// Branch proposals from outside the editor (for example an AI draft), as data. A proposal is a
// list of steps that runs through the same commands as the screen and becomes one Undo step.
// The Host shows it for preview, then applies or rejects it.
import { immutableCommand, type EditorCommand } from '@editor-platform/editor-core';
import {
  addMindmapNode,
  collapseMindmapNode,
  colorMindmapNode,
  deleteMindmapNode,
  markMindmapNode,
  moveMindmapNode,
  noteMindmapNode,
  renameMindmapNode,
  reorderMindmapNode,
  setMindmapLayout,
} from './commands';
import {
  MINDMAP_MARKS,
  MindmapError,
  NODE_ID,
  newMindmapNodeId,
  validateMindmap,
  type MindmapContent,
  type MindmapLayout,
  type MindmapMark,
} from './model';

export const MINDMAP_STEP_KINDS = [
  'add',
  'rename',
  'reorder',
  'move',
  'delete',
  'collapse',
  'color',
  'marks',
  'note',
  'layout',
] as const;
export type MindmapStepKind = (typeof MINDMAP_STEP_KINDS)[number];

export interface MindmapStep {
  kind: MindmapStepKind;
  id?: string;
  parentId?: string;
  index?: number;
  text?: string;
  side?: 'left' | 'right';
  collapsed?: boolean;
  marks?: MindmapMark[];
}

export interface MindmapProposalInput {
  /** The content fingerprint the proposal was made from (32 hex digits); other values are the Host's. */
  before?: string;
  steps: MindmapStep[];
}

const text = (maxLength: number) => ({ type: 'string' as const, maxLength });
const stepSchema = {
  type: 'object' as const,
  properties: {
    kind: { type: 'string' as const, maxLength: 10, enum: [...MINDMAP_STEP_KINDS] },
    id: text(34),
    parentId: text(34),
    index: { type: 'integer' as const, minimum: 0, maximum: 200 },
    text: text(4000),
    side: { type: 'string' as const, maxLength: 5, enum: ['left', 'right'] },
    collapsed: { type: 'boolean' as const },
    marks: {
      type: 'array' as const,
      maxItems: 4,
      items: { type: 'string' as const, maxLength: 8, enum: [...MINDMAP_MARKS] },
    },
  },
  required: ['kind'],
  additionalProperties: false as const,
};

/** The closed JSON schema of a proposal, as a Host publishes it to proposal authors. */
export const mindmapProposalDeclaration = {
  id: 'edit-branch',
  version: '1.0.0',
  title: '枝の操作',
  inputSchema: {
    type: 'object' as const,
    properties: {
      before: text(32),
      steps: { type: 'array' as const, items: stepSchema, minItems: 1, maxItems: 100 },
    },
    required: ['steps'],
    additionalProperties: false as const,
  },
} as const;

const specs: Record<MindmapStepKind, { required: string[]; optional?: string[] }> = {
  add: { required: ['parentId', 'text'], optional: ['id', 'index', 'side'] },
  rename: { required: ['id', 'text'] },
  reorder: { required: ['id', 'index'] },
  move: { required: ['id', 'parentId', 'index'], optional: ['side'] },
  delete: { required: ['id'] },
  collapse: { required: ['id', 'collapsed'] },
  color: { required: ['id'], optional: ['text'] },
  marks: { required: ['id'], optional: ['marks'] },
  note: { required: ['id'], optional: ['text'] },
  layout: { required: ['text'] },
};

function parse(value: unknown): MindmapProposalInput {
  const bad = () => new MindmapError('操作の入力が不正です。');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => k !== 'before' && k !== 'steps') ||
    ('before' in v && (typeof v.before !== 'string' || v.before.length > 32)) ||
    !Array.isArray(v.steps) ||
    !v.steps.length ||
    v.steps.length > 100
  )
    throw bad();
  for (const [i, raw] of v.steps.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new MindmapError('操作が不正です。');
    const s = raw as Record<string, unknown>;
    const spec =
      typeof s.kind === 'string' && Object.hasOwn(specs, s.kind)
        ? specs[s.kind as MindmapStepKind]
        : undefined;
    if (
      !spec ||
      spec.required.some((k) => !(k in s)) ||
      Object.keys(s).some((k) => !['kind', ...spec.required, ...(spec.optional ?? [])].includes(k))
    )
      throw new MindmapError(
        `${i + 1} 番目の操作（${String(s.kind)}）の項目が不正です。要る項目：${spec ? spec.required.join('・') : 'kind'}`,
      );
    for (const k of ['id', 'parentId', 'text', 'side'])
      if (k in s && typeof s[k] !== 'string') throw new MindmapError('文字列が必要です。');
    if (
      'index' in s &&
      (!Number.isInteger(s.index) || (s.index as number) < 0 || (s.index as number) > 200)
    )
      throw new MindmapError('位置が不正です。');
    if ('collapsed' in s && typeof s.collapsed !== 'boolean')
      throw new MindmapError('折りたたみが不正です。');
    if (
      'marks' in s &&
      (!Array.isArray(s.marks) || s.marks.length > 4 || s.marks.some((m) => typeof m !== 'string'))
    )
      throw new MindmapError('印が不正です。');
  }
  return {
    before: typeof v.before === 'string' ? v.before : undefined,
    steps: structuredClone(v.steps) as MindmapStep[],
  };
}

/** A 32-hex-digit fingerprint of the content, which a proposal names as its `before`. */
export function mindmapFingerprint(content: MindmapContent): string {
  let a = 14695981039346656037n,
    b = 7809847782465536322n;
  for (const byte of new TextEncoder().encode(JSON.stringify(content))) {
    a = BigInt.asUintN(64, (a ^ BigInt(byte)) * 1099511628211n);
    b = BigInt.asUintN(64, (b ^ BigInt(byte)) * 1099511628211n);
  }
  return a.toString(16).padStart(16, '0') + b.toString(16).padStart(16, '0');
}

function stepCommand(s: MindmapStep): EditorCommand<MindmapContent> {
  switch (s.kind) {
    case 'add':
      // An omitted position adds at the end of the parent's children at apply time.
      return {
        type: 'mindmap.add',
        label: '枝を足す',
        apply: (c) =>
          addMindmapNode(
            s.parentId!,
            s.index ?? c.nodes[s.parentId!]?.children.length ?? 0,
            s.id!,
            s.text!,
            s.side,
          ).apply(c),
      };
    case 'rename':
      return renameMindmapNode(s.id!, s.text!);
    case 'reorder':
      return reorderMindmapNode(s.id!, s.index!);
    case 'move':
      return moveMindmapNode(s.id!, s.parentId!, s.index!, s.side);
    case 'delete':
      return deleteMindmapNode(s.id!);
    case 'collapse':
      return collapseMindmapNode(s.id!, s.collapsed!);
    case 'color':
      return colorMindmapNode(s.id!, s.text);
    case 'marks':
      return markMindmapNode(s.id!, s.marks);
    case 'note':
      return noteMindmapNode(s.id!, s.text);
    case 'layout':
      return setMindmapLayout(s.text as MindmapLayout);
  }
}

const isFingerprint = (v: string | undefined): v is string => !!v && /^[0-9a-f]{32}$/.test(v);

/**
 * The one command a proposal becomes, checked against `content` now. Added nodes may omit their
 * id or use a temporary name (such as `new-1`); those get fresh ids, also where later steps name
 * them. The command refuses to apply to content that differs from `content`.
 */
export function mindmapProposalCommand(
  value: unknown,
  content: MindmapContent,
): EditorCommand<MindmapContent> {
  const input = parse(value);
  validateMindmap(content);
  const temporary = new Map<string, string>();
  for (const s of input.steps) {
    if (s.kind === 'add' && (s.id === undefined || !NODE_ID.test(s.id))) {
      const id = newMindmapNodeId();
      if (s.id !== undefined) temporary.set(s.id, id);
      s.id = id;
    } else if (s.id !== undefined && temporary.has(s.id)) s.id = temporary.get(s.id);
    if (s.parentId !== undefined && temporary.has(s.parentId))
      s.parentId = temporary.get(s.parentId);
  }
  const steps = input.steps.map(stepCommand);
  const original = JSON.stringify(content);
  const apply = (current: MindmapContent) => {
    validateMindmap(current);
    if (
      (isFingerprint(input.before) && mindmapFingerprint(current) !== input.before) ||
      JSON.stringify(current) !== original
    )
      throw new MindmapError('基準の文書が変更されています。');
    return steps.reduce((c, step) => step.apply(c), current);
  };
  apply(content);
  return immutableCommand<MindmapContent>('mindmap.branch', '枝の操作', apply);
}

/** Why a proposal cannot apply to `content`; empty when it can. */
export function mindmapProposalProblems(value: unknown, content: MindmapContent): string[] {
  try {
    mindmapProposalCommand(value, content);
    return [];
  } catch (e) {
    return [e instanceof Error ? e.message : '入力が不正です。'];
  }
}
