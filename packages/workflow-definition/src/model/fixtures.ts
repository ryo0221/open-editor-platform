// Test helpers only: the pinned OWD copy (fixtures/owd-446706b, MIT) and its definitions.
import { check } from '../../fixtures/owd-446706b/src/check.mjs';
import editorDevelopment from '../../fixtures/owd-446706b/definitions/editor-development.json';
import fictionManga from '../../fixtures/owd-446706b/definitions/fiction-manga.json';
import productDesign from '../../fixtures/owd-446706b/definitions/product-design-engineering.json';
import softwareRefactoring from '../../fixtures/owd-446706b/definitions/software-refactoring.json';
import { clone } from '@editor-platform/artifact-core';
import { type OwdDefinition } from './types';

export const owdCheck = (definition: unknown) => check(clone(definition));
export const owdFixtures = {
  'editor-development': editorDevelopment,
  'fiction-manga': fictionManga,
  'product-design-engineering': productDesign,
  'software-refactoring': softwareRefactoring,
} as unknown as Record<string, OwdDefinition>;
export const fixture = (id: keyof typeof owdFixtures | string) => clone(owdFixtures[id]);
/** A small fictional definition: two sections, three phases, one cycle-free order. */
export function sampleDefinition(): OwdDefinition {
  return clone<unknown>({
    format: 1,
    id: 'sample-plan',
    version: '1.0.0',
    title: '見本の計画',
    purpose: '小さな見本を作る',
    phases: [
      {
        id: 'research',
        name: '調べる',
        purpose: '材料を集める',
        after: [],
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
        purpose: '振り返る',
        after: ['plan'],
        deliverables: ['plan-doc'],
        acceptance: ['plan.ok'],
        icon: 'list',
      },
    ],
    sections: [
      { id: 'early', name: '前半', phases: ['research', 'plan'] },
      { id: 'late', name: '後半', phases: ['review'] },
    ],
    deliverables: [
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
        outline: [{ heading: '要求', describe: '要求', item: 'req' }],
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
    roles: [{ id: 'lead', name: 'リーダー' }],
    acceptance: [
      { id: 'notes.ok', text: '事実がある', checkedBy: '人', target: 'notes' },
      {
        id: 'plan.ok',
        text: '要求が事実を引く',
        checkedBy: '人',
        target: 'plan-doc',
        rules: ['req-cites-fact', 'fact-covered'],
        approvers: { roles: ['lead'] },
      },
    ],
    gates: [{ name: 'lint', run: 'npm run lint', phases: ['plan'] }],
  }) as OwdDefinition;
}
