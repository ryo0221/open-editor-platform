/**
 * The ladder program's canonical content (docs/cad/circuit-simulation.md, SL6, SL-U4): IEC
 * 61131-3 Ladder Diagram with IEC variable names. A rung is a series/parallel network of contacts
 * (and timer, counter and compare boxes in series) from the left power rail, ending in coils.
 * Schema 1 is the only schema.
 */

export const ladderSchemaVersion = 1;

/** Elementary types, and the standard function blocks a variable may be an instance of. */
export const ladderTypes = ['BOOL', 'INT', 'TIME', 'TON', 'TOF', 'TP', 'CTU', 'CTD'] as const;
export type LadderType = (typeof ladderTypes)[number];
export const ladderTimerTypes = ['TON', 'TOF', 'TP'] as const;
export const ladderCounterTypes = ['CTU', 'CTD'] as const;
/** Where a variable's value comes from: the process (input), goes to it (output), or neither. */
export const ladderRoles = ['input', 'output', 'internal'] as const;
export type LadderRole = (typeof ladderRoles)[number];

export interface LadderVariable {
  /** An IEC identifier, unique in the program (compared without case, as IEC does). */
  name: string;
  type: LadderType;
  role: LadderRole;
  /** Initial value: BOOL false/true, INT and TIME (ms) a whole number. None for blocks. */
  initial?: boolean | number;
  comment?: string;
}

export const ladderContactKinds = ['no', 'nc', 'rising', 'falling'] as const;
export type LadderContactKind = (typeof ladderContactKinds)[number];
export const ladderCompareOps = ['eq', 'ne', 'gt', 'ge', 'lt', 'le'] as const;
export type LadderCompareOp = (typeof ladderCompareOps)[number];

/** An operand of a compare box: a variable (INT or TIME, or a counter's CV / timer's ET) or a literal. */
export type LadderOperand = { variable: string; member?: 'CV' | 'ET' } | { value: number };

/** A network element. Every node has an ID unique in the program. */
export type LadderNode =
  | { id: string; kind: 'contact'; variable: string; contact: LadderContactKind }
  | { id: string; kind: 'series'; items: LadderNode[] }
  | { id: string; kind: 'parallel'; branches: LadderNode[] }
  /** A timer box (TON/TOF/TP instance): power in is IN, power out is Q; `presetMs` is PT. */
  | { id: string; kind: 'timer'; instance: string; presetMs: number }
  /**
   * A counter box (CTU/CTD instance): power in is CU (CD); `reset` drives R (CTU) or LD (CTD);
   * power out is Q.
   */
  | { id: string; kind: 'counter'; instance: string; preset: number; reset?: string }
  /** A compare box: power out is power in AND (a op b). */
  | { id: string; kind: 'compare'; op: LadderCompareOp; a: LadderOperand; b: LadderOperand };

export const ladderCoilKinds = ['normal', 'negated', 'set', 'reset'] as const;
export type LadderCoilKind = (typeof ladderCoilKinds)[number];
export interface LadderCoil {
  id: string;
  variable: string;
  coil: LadderCoilKind;
}

export interface LadderRung {
  id: string;
  comment?: string;
  /** From the left rail; an empty series is the rail itself (always powered). */
  network: LadderNode;
  /** In parallel at the end of the network. */
  coils: LadderCoil[];
}

export interface LadderDocument {
  schemaVersion: 1;
  name: string;
  /** The scan period (ms): the virtual time a scan advances timers by. */
  scanMs: number;
  variables: LadderVariable[];
  rungs: LadderRung[];
}

/** Initial safety limits (refused as `limit-*`); not performance promises. */
export const ladderLimits = Object.freeze({
  variables: 1000,
  rungs: 500,
  nodesPerRung: 200,
  depth: 16,
  nameLength: 64,
  commentLength: 1000,
});
