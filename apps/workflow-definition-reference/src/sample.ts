/** A fictional public definition for the reference Host (not one of the published OWD ones). */
import { deepFreeze } from '@editor-platform/artifact-core';
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
