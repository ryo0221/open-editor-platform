import { createEstimate } from './types';
/** Synthetic quantities/prices for construction regression, not market prices. */
export function constructionFixture(count: number) {
  const doc = createEstimate('建設回帰用の架空見積');
  for (let i = 0; i < count; i++) {
    doc.quantities.push({
      id: `q${i}`,
      name: `工区${i + 1} 数量`,
      unit: 'm2',
      value: '350',
      quality: 'manual',
      evidence: '架空の図面数量',
      inclusion: 'include',
      exclusionReason: '',
    });
    doc.rates.push({
      id: `r${i}`,
      name: `単価${i + 1}`,
      perUnit: 'm2',
      unitPrice: '32000',
      currency: 'JPY',
      evidence: '架空単価',
    });
    doc.lines.push({
      id: `l${i}`,
      name: `工区${i + 1} 費目`,
      category: i % 2 ? '内装' : '外装',
      note: '架空',
      bindings: [{ quantityId: `q${i}`, allocationRatio: '1' }],
      rateId: `r${i}`,
      wasteRatio: '0',
      inclusion: 'include',
      exclusionReason: '',
    });
  }
  return doc;
}
