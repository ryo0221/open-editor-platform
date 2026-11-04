import { mountCreativeProduction } from './browser';
import { showCreativeError } from '../browser';
void mountCreativeProduction().catch(showCreativeError);
