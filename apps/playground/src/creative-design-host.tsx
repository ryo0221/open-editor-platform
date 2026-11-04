import { characterMode } from '@editor-platform/reference-artifact-host/creative';
import {
  mountCreativeMode,
  showCreativeError,
} from '@editor-platform/reference-artifact-host/creative/browser';
void mountCreativeMode(characterMode).catch(showCreativeError);
