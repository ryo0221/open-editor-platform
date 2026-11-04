import { mountStoryTimeline } from './browser';
import { showCreativeError } from '../browser';
void mountStoryTimeline().catch(showCreativeError);
