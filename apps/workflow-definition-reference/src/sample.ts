/** A fictional public definition for the reference Host (not one of the published OWD ones). */
import { deepFreeze } from '@editor-platform/artifact-core';
import { type MindmapContent } from '@editor-platform/mindmap-core';
import { type WorkflowDefinitionProposal } from '@editor-platform/workflow-definition';
import { type OwdDefinition } from '@editor-platform/workflow-definition/model';

export const sampleDefinition = deepFreeze({
  format: 1,
  id: 'sample-plan',
  version: '1.0.0',
  title: '見本の計画',
  purpose: '小さな見本の計画を、調べてから書き、振り返る。',
  phases: [
    {
      id: 'process',
      name: '進め方',
      purpose: '進め方を決める',
      after: [],
      deliverables: ['process-map'],
      acceptance: ['process.ok'],
    },
    {
      id: 'research',
      name: '調べる',
      purpose: '材料を集める',
      after: ['process'],
      deliverables: ['notes'],
      acceptance: ['notes.ok'],
    },
    {
      id: 'plan',
      name: '計画',
      purpose: '計画を書く',
      after: ['research'],
      deliverables: ['plan-doc'],
      acceptance: ['plan.ok'],
    },
    {
      id: 'review',
      name: '振り返り',
      purpose: '計画を振り返る',
      after: ['plan'],
      deliverables: ['plan-doc'],
      acceptance: ['plan.ok'],
    },
  ],
  sections: [
    { id: 'early', name: '前半', phases: ['process', 'research'] },
    { id: 'late', name: '後半', phases: ['plan', 'review'] },
  ],
  deliverables: [
    {
      id: 'process-map',
      name: '工程計画',
      form: '文書',
      outline: [{ heading: '対象', describe: '何を作るか' }],
    },
    {
      id: 'notes',
      name: 'メモ',
      form: '文書',
      outline: [{ heading: '事実', describe: '集めた事実', item: 'fact' }],
    },
    {
      id: 'plan-doc',
      name: '計画書',
      form: '文書',
      outline: [{ heading: '要求', describe: '要求と根拠', item: 'req' }],
      uses: ['notes'],
    },
  ],
  items: [
    { id: 'fact', name: '事実', idForm: 'F-{nn}' },
    { id: 'req', name: '要求', idForm: 'R-{nn}' },
  ],
  rules: [
    { id: 'req-cites-fact', type: 'cites', from: 'req', to: ['fact'], min: 1 },
    { id: 'fact-covered', type: 'covered', of: 'fact', by: ['req'] },
  ],
  roles: [{ id: 'lead', name: 'リーダー', text: '計画を受け入れる人' }],
  acceptance: [
    { id: 'process.ok', text: '対象が書かれている', checkedBy: '人', target: 'process-map' },
    { id: 'notes.ok', text: '事実が集まっている', checkedBy: '人', target: 'notes' },
    {
      id: 'plan.ok',
      text: '要求が事実を引いている',
      checkedBy: '人',
      target: 'plan-doc',
      rules: ['req-cites-fact', 'fact-covered'],
      approvers: { roles: ['lead'] },
    },
  ],
} as unknown as OwdDefinition);

const node = (n: number) => `n-${n.toString(16).padStart(32, '0')}`;
/** The Mind Map the sample was worked out in: two branches are linked, two are not yet. */
export const sampleMindmap = deepFreeze({
  artifactKind: 'mindmap',
  schemaVersion: 1,
  id: `d-${'a'.repeat(32)}`,
  rootId: node(1),
  layout: 'right',
  nodes: {
    [node(1)]: { id: node(1), text: '見本の計画', children: [node(2), node(3), node(4), node(5)] },
    [node(2)]: {
      id: node(2),
      text: '調べる',
      children: [],
      link: { namespace: 'owd:sample-plan', id: 'phase:research' },
    },
    [node(3)]: {
      id: node(3),
      text: '計画書',
      children: [],
      link: { namespace: 'owd:sample-plan', id: 'deliverable:plan-doc' },
    },
    [node(4)]: { id: node(4), text: 'Pilot', children: [] },
    [node(5)]: { id: node(5), text: '関係者の合意', children: [] },
  },
} as unknown as MindmapContent);
/** An outside draft (as an AI would make it), proposed as definition intents. */
export const sampleProposal: WorkflowDefinitionProposal = {
  label: '振り返りの条件を足す',
  intents: [
    {
      type: 'add',
      kind: 'acceptance',
      id: 'review.ok',
      fields: { text: '振り返りが計画書に残っている', checkedBy: '人', target: 'plan-doc' },
    },
    {
      type: 'set-fields',
      kind: 'phase',
      id: 'review',
      fields: { acceptance: ['plan.ok', 'review.ok'] },
    },
  ],
};
