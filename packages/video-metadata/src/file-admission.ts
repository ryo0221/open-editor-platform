/**
 * The video file admission a producer can test against (C8b): what an MP4 must be for the
 * Host's file import to take it (metadata, sample index and the bounded AVC profile). Reading
 * only; it decodes nothing.
 */
export { inspectOriginalV1 as inspectVideoFile } from '../host-media/file-source/inspect-v1';
