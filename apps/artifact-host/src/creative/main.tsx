import { characterMode } from './character-mode';
import { mountCreativeMode, showCreativeError } from './browser';
void mountCreativeMode(characterMode).catch(showCreativeError);
