import { expect, it } from 'vitest';
import { constructionFixture } from './construction-fixture';
import { evaluateEstimate, makeEstimateBasis } from './evaluate';
it('diagnostics identify their collection, including work/line errors sharing a code and ID', () => {
  const d = constructionFixture(1);
  d.rates[0].unitPrice = null;
  d.adjustments = [
    {
      id: 'l0',
      name: '調整',
      kind: 'percent',
      value: '0.1',
      basisLineIds: ['l0'],
      reason: 'fixture',
    },
  ];
  expect(evaluateEstimate(makeEstimateBasis(d)).diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'l0', code: 'missing-price', target: 'line' }),
      expect.objectContaining({
        id: 'l0',
        code: 'incomplete-adjustment-basis',
        target: 'adjustment',
      }),
    ]),
  );
  d.adjustments = [];
  d.rates[0].unitPrice = '32000';
  d.lines[0].id = 'work-plan';
  d.workRules = [
    {
      id: 'crew',
      name: '班',
      setupHours: '0',
      hoursPerUnit: '1',
      perUnit: 'kg',
      crewCount: 1,
      hoursPerDay: '8',
    },
  ];
  d.workPlan = {
    projectStartDate: '2026-10-26',
    calendar: { weekdays: [1], exceptions: [] },
    tasks: [{ id: 'task', name: '工程', lineId: 'work-plan', ruleId: 'crew' }],
    dependencies: [],
  };
  expect(evaluateEstimate(makeEstimateBasis(d)).diagnostics[0]).toMatchObject({
    id: 'work-plan',
    code: 'unit-mismatch',
    target: 'work',
  });
  d.rates[0].perUnit = 'kg';
  expect(evaluateEstimate(makeEstimateBasis(d)).diagnostics[0]).toMatchObject({
    id: 'work-plan',
    code: 'unit-mismatch',
    target: 'line',
  });
});
