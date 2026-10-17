/** Node bindings for the single private portable ZIP64 profile. */
import { scan } from './io';
import { createZip } from './portable/zip64';
export type { Entry } from './portable/zip64';
export const { archiveSize, writeZip, readZip } = createZip(scan);
