import { settingMode } from './setting-mode';
import { mountCreativeMode, showCreativeError } from './browser';
void mountCreativeMode(settingMode).catch(showCreativeError);
