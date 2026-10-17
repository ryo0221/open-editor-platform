/** Provisional v0 APIs; no Host registration or codec support is implied. */
export * from './time';
export * from './model';
export * from './validation';
export * from './commands';
export * from './evaluate';
export * from './media';

/** Explicit v1 opt-in; legacy names continue to accept v0 only. */
export * from './v1/model';
export * from './v1/validation';
export * from './v1/commands';
export * from './v1/evaluate';

/** Explicit private v2 gain/fade opt-in; v0/v1 validators and records are unchanged. */
export * from './v2/model';
export { assertVideoContentV2, adoptVideoContentV2 } from './v2/validation';
export * from './v2/commands';
export * from './v2/gain';
