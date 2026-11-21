import { defineKind } from '@editor-platform/artifact-kinds';
import {
  f75Pi5Example,
  f76HatBoard,
  isPcbDocument,
  pcbStarter,
  type PcbDocument,
} from '@editor-platform/pcb-core';

/** PB8: what a new circuit board starts as. */
export const pcbTemplates = [
  { id: 'empty', label: 'Empty board', name: 'Circuit board' },
  { id: 'pi5', label: 'Raspberry Pi 5 form factor (F75)', name: 'Pi 5 form factor' },
  { id: 'hat', label: 'Sensor HAT+ (F76)', name: 'Sensor HAT+' },
] as const;
export type PcbTemplateId = (typeof pcbTemplates)[number]['id'];

/** The Circuit board kind. Options: `{ template }`, one of `pcbTemplates` (default empty). */
export const pcbKind = defineKind<PcbDocument>({
  kind: 'pcb',
  area: 'engineering',
  label: 'Circuit board',
  icon: '▦',
  description: 'Lay out a printed circuit board: outline, layers and holes',
  creatable: true,
  create(count, options) {
    const template: PcbTemplateId =
      (options as { template?: PcbTemplateId } | undefined)?.template ?? 'empty';
    return {
      name: `${pcbTemplates.find((t) => t.id === template)!.name} ${count}`,
      content:
        template === 'pi5' ? f75Pi5Example() : template === 'hat' ? f76HatBoard() : pcbStarter(),
    };
  },
  validate: isPcbDocument,
});
