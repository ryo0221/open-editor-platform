// The headless contract for an Artifact kind: what it is called, how a new one is made and how
// stored content is checked. No React and no Editor package: a Host pairs a definition with its
// own Surface (see docs/kind-registry-design.md, 「種類の定義」).

export type KindArea = 'office' | 'engineering';

/** Data kept on the record next to `content` (the same names as the Hosts' stored record). */
export interface KindRecordExtras {
  cadResources?: unknown[];
  cadParts?: unknown[];
  simulationSources?: unknown[];
  constructionSources?: unknown[];
  geoResources?: unknown[];
}

/** A new Artifact of a kind: its name, content and the data kept beside the content. */
export interface KindInitial<C> {
  name: string;
  content: C;
  extras?: KindRecordExtras;
}

export interface KindDefinition<C> {
  /** The stored kind name ('cad', 'document', ...). */
  kind: string;
  area: KindArea;
  label: string;
  icon: string;
  description: string;
  /** Whether the Host may offer it in its "new" list. */
  creatable: boolean;
  /** A new Artifact. `count` numbers the default name; `options` is what the user chose. */
  create(count: number, options?: unknown): KindInitial<C>;
  /** Whether stored content is this kind's content. */
  validate(content: unknown): content is C;
}

/** A definition whose content type is erased so that kinds can share one list. */
export interface RegisteredKind {
  readonly kind: string;
  readonly area: KindArea;
  readonly label: string;
  readonly icon: string;
  readonly description: string;
  readonly creatable: boolean;
  create(count: number, options?: unknown): KindInitial<unknown>;
  validate(content: unknown): boolean;
}

/** A typed definition; the type is kept until a Host pairs it with a Surface or registers it. */
export function defineKind<C>(definition: KindDefinition<C>): KindDefinition<C> {
  return definition;
}

/** Erase the content type for a shared list. `C` cannot be recovered afterwards. */
export function registerKind<C>(definition: KindDefinition<C>): RegisteredKind {
  const { kind, area, label, icon, description, creatable } = definition;
  return Object.freeze({
    kind,
    area,
    label,
    icon,
    description,
    creatable,
    create: (count: number, options?: unknown) => definition.create(count, options),
    validate: (content: unknown) => definition.validate(content),
  });
}

export interface KindRegistry {
  /** The definition of a stored kind name, or undefined for a kind this Host does not know. */
  get(kind: string): RegisteredKind | undefined;
  /** Every registered kind, in registration order. */
  all(): readonly RegisteredKind[];
  /** The kinds the Host may offer as new. */
  creatable(): readonly RegisteredKind[];
  /** Whether `content` is valid for `kind`; unknown kinds are never valid. */
  validate(kind: string, content: unknown): boolean;
}

/** One list of kinds. Registering a kind name twice is an error at start-up. */
export function createKindRegistry(kinds: readonly RegisteredKind[]): KindRegistry {
  const byName = new Map<string, RegisteredKind>();
  for (const entry of kinds) {
    if (byName.has(entry.kind)) throw new Error(`Kind registered twice: ${entry.kind}`);
    byName.set(entry.kind, entry);
  }
  const all = Object.freeze([...kinds]);
  const creatable = Object.freeze(all.filter((entry) => entry.creatable));
  return {
    get: (kind) => byName.get(kind),
    all: () => all,
    creatable: () => creatable,
    validate: (kind, content) => byName.get(kind)?.validate(content) ?? false,
  };
}

/**
 * One Host entry per registered kind, made from the same definition object the registry lists.
 * A kind without an entry, a second entry or an entry made from another definition is an error
 * at start-up, like a kind registered twice. `what` names the entries in the error.
 */
export function pairKinds<E extends { readonly kind: string; readonly definition: unknown }>(
  definitions: readonly KindDefinition<unknown>[],
  entries: readonly E[],
  what: string,
): ReadonlyMap<string, E> {
  const byKind = new Map<string, E>();
  for (const entry of entries) {
    if (byKind.has(entry.kind)) throw new Error(`${what} registered twice: ${entry.kind}`);
    byKind.set(entry.kind, entry);
  }
  for (const definition of definitions) {
    const entry = byKind.get(definition.kind);
    if (!entry) throw new Error(`No ${what} for kind: ${definition.kind}`);
    if (entry.definition !== definition)
      throw new Error(`${what} for ${definition.kind} uses another definition`);
  }
  if (byKind.size !== definitions.length)
    throw new Error(
      `${what} without a registered kind: ${[...byKind.keys()]
        .filter((kind) => !definitions.some((definition) => definition.kind === kind))
        .join(', ')}`,
    );
  return byKind;
}
