/**
 * The MP4 writer of C8b for other editors (CS6c's schedule video): WebCodecs H.264 frames into
 * an MP4, without the character surface.
 */
export {
  browserVideoEncoding,
  encodeMp4,
  type FrameLike,
  type Mp4Frames,
  type VideoEncodeSource,
  type VideoEncoding,
} from './video-encode';
export {
  VideoExportError,
  videoLimits,
  videoSizes,
  type VideoExportCode,
  type VideoProgress,
} from './video-export';
