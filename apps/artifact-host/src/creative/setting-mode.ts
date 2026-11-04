import type { DocumentContent } from '@editor-platform/document/model';
import type { CreativeMode } from './types';
import { settingSourceConfig } from './setting-source';
import { createSettingDesign, settingComponentId, settingGroups } from './setting-preset';

export const settingMode: CreativeMode<DocumentContent> = {
  ...settingSourceConfig,
  design: createSettingDesign,
  componentId: settingComponentId,
  groups: settingGroups,
};
