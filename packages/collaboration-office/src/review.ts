import { fail, type DomainCodec } from '@editor-platform/collaboration-core';
import {
  isReview,
  isFile,
  reviewRevision,
  type ReviewContent,
  type FileContent,
} from '@editor-platform/review-surfaces/model';
export const reviewCodec: DomainCodec<ReviewContent> = {
  domain: 'review',
  validate: isReview,
  resource: (d, key) => d.files.find((f) => f.id === key),
  validateAnchor: (d, a) => {
    if (a.type !== 'fixed' || !['old', 'new'].includes(a.side ?? '')) return false;
    const file = d.files.find((f) => f.id === a.elementId);
    return !!file && reviewRevision(file, a.side!) === a.versionId;
  },
  apply: () =>
    fail(
      'unsupported-operation',
      'Comparison sources are immutable in shared sessions; annotations are supported',
    ),
};
export const fileCodec: DomainCodec<FileContent> = {
  domain: 'file',
  validate: isFile,
  resource: (d) => d,
  validateAnchor: (d, a) =>
    a.type === 'fixed' &&
    a.elementId === d.id &&
    a.versionId === d.id &&
    (a.page === undefined || (Number.isSafeInteger(a.page) && a.page >= 1)),
  apply: () =>
    fail(
      'unsupported-operation',
      'Original file bytes are immutable in shared sessions; annotations are supported',
    ),
};
