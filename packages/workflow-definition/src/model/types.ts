/**
 * The open-workflow-definitions (OWD) format 1 JSON, as this package reads and writes it. Only the
 * fields the Editor edits are typed; every other field (gates, placements, views, fields a later
 * format adds) is kept as it is, because edits clone the whole definition and change named fields.
 */
export type OwdJson = null | string | number | boolean | OwdJson[] | { [key: string]: OwdJson };
export type OwdRecord = { [key: string]: OwdJson };
export interface OwdPhase extends OwdRecord {
  id: string;
  name: string;
  purpose: string;
  /** Phases finished before this one. */
  after: string[];
  deliverables: string[];
  acceptance: string[];
}
export interface OwdSection extends OwdRecord {
  id: string;
  name: string;
  phases: string[];
}
export interface OwdOutlineEntry extends OwdRecord {
  heading: string;
  describe: string;
}
export interface OwdDeliverable extends OwdRecord {
  id: string;
  name: string;
  form: string;
  outline: OwdOutlineEntry[];
}
export interface OwdItem extends OwdRecord {
  id: string;
  name: string;
  idForm: string;
}
export interface OwdRule extends OwdRecord {
  id: string;
  type: 'cites' | 'covered';
}
export interface OwdRole extends OwdRecord {
  id: string;
  name: string;
}
export interface OwdAcceptance extends OwdRecord {
  id: string;
  text: string;
  checkedBy: '人' | 'AI';
  target: string;
}
export interface OwdDefinition extends OwdRecord {
  format: 1;
  id: string;
  version: string;
  title: string;
  purpose: string;
  phases: OwdPhase[];
  deliverables: OwdDeliverable[];
  acceptance: OwdAcceptance[];
}
