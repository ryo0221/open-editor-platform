import type { CreativeMode } from './types';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { characterSourceConfig } from './character-source';
import { characterComponentId, characterGroups, createCharacterDesign } from './character-preset';

export const characterMode: CreativeMode<StructuredData> = {
  ...characterSourceConfig,
  title: 'キャラクター設計',
  design: createCharacterDesign,
  componentId: characterComponentId,
  groups: characterGroups,
};
