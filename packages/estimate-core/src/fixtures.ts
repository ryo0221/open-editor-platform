import { createEstimate } from './types';
export function estimateFixture() {
  const d = createEstimate('架空の部品見積');
  d.quantities = [
    {
      id: 'panel',
      name: 'パネル',
      unit: 'count',
      value: '1',
      quality: 'manual',
      evidence: '架空fixture・手入力',
      inclusion: 'include',
      exclusionReason: '',
    },
    {
      id: 'bolt',
      name: 'ボルト',
      unit: 'count',
      value: '6',
      quality: 'manual',
      evidence: '架空fixture・手入力',
      inclusion: 'include',
      exclusionReason: '',
    },
  ];
  d.rates = [
    {
      id: 'panel-price',
      name: 'パネル単価',
      unitPrice: '1200',
      perUnit: 'count',
      currency: 'JPY',
      evidence: '検査用の架空価格',
    },
    {
      id: 'bolt-price',
      name: 'ボルト単価',
      unitPrice: '25',
      perUnit: 'count',
      currency: 'JPY',
      evidence: '検査用の架空価格',
    },
  ];
  d.lines = d.quantities.map((q) => ({
    id: `line-${q.id}`,
    name: q.name,
    category: '材料',
    note: '',
    bindings: [{ quantityId: q.id, allocationRatio: '1' }],
    rateId: `${q.id}-price`,
    wasteRatio: '0',
    inclusion: 'include',
    exclusionReason: '',
  }));
  return d;
}
