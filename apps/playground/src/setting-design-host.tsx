import { settingMode } from '@editor-platform/reference-artifact-host/creative/setting';
import {
  mountCreativeMode,
  showCreativeError,
} from '@editor-platform/reference-artifact-host/creative/browser';
void mountCreativeMode(settingMode).catch(showCreativeError);
