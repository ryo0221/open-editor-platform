/** Read-only public entrypoint: no React/Surface/CSS or AI runtime. */
export type { TimelineSavedComparisonSource } from './timeline/analysis-context';
export { compareTimelineSavedFacets } from './timeline/saved-comparison';
export type {
  TimelineSavedComparisonRequest,
  TimelineSavedFacet,
} from './timeline/saved-comparison';
export { compareCreativeSavedContent } from './workspace/saved-content-comparison';
export type { CreativeSavedContentRequest } from './workspace/saved-content-comparison';
