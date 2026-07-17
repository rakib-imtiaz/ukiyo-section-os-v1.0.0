/**
 * CONTRACT VERSION MIGRATION FRAMEWORK
 *
 * The SectionManifest design contract is versioned by its `contractVersion`
 * field. When the contract evolves, older manifests (saved projects, pasted
 * agent output, exported JSON) must be upgraded before validation so the rest
 * of the pipeline only ever sees the current shape.
 *
 * How it works:
 *   - `contractMigrations` is a registry of single-step upgrade functions.
 *     Each step maps exactly one version to the next (`from` → `to`).
 *   - `migrateContract` detects the input's version and runs the chain of
 *     steps until it reaches CURRENT_CONTRACT_VERSION.
 *   - Manifests with no `contractVersion` at all are treated as version 0
 *     ("versionless" — pre-contract output); the 0 → 1 step stamps the field.
 *   - Manifests already at the current version pass through UNTOUCHED — the
 *     exact same object reference is returned, so valid v1 manifests behave
 *     byte-identically to the pre-migration pipeline.
 *
 * `validateManifest` (./validation.ts) calls `migrateContract` first and
 * surfaces `migratedFrom` in its result so callers can show "upgraded from
 * vX" (0 meaning "a versionless manifest").
 *
 * ADDING A NEW VERSION (the pattern, using a hypothetical v2):
 *   1. Bump CURRENT_CONTRACT_VERSION to 2.
 *   2. Update the zod schema in ./validation.ts (`contractVersion: z.literal(2)`
 *      plus whatever structural change motivated the bump) and the TS types in
 *      ../shared/types.ts.
 *   3. Register the upgrade step below — see the commented example stub.
 *   Existing v0/v1 manifests then upgrade transparently through the chain
 *   (0 → 1 → 2) the next time they are validated or compiled.
 */

/** The contract version the compiler currently emits and validates. */
export const CURRENT_CONTRACT_VERSION = 1;

export interface ContractMigration {
  /** The contractVersion this step upgrades FROM (0 = versionless). */
  from: number;
  /** The contractVersion this step produces. Must be `from + 1`. */
  to: number;
  /**
   * Upgrade a manifest one version step. Receives `unknown` because pre-current
   * shapes are, by definition, not the current SectionManifest type. Must NOT
   * mutate its input — return a new object.
   */
  migrate(manifest: unknown): unknown;
}

/**
 * Ordered registry of upgrade steps. `migrateContract` chains these by
 * matching `from` against the detected version, so gaps break the chain —
 * every version bump needs exactly one entry here.
 */
export const contractMigrations: ContractMigration[] = [
  {
    // v0 → v1: "versionless" manifests predate the contractVersion field.
    // Structurally they are already v1, so the upgrade just stamps the field.
    from: 0,
    to: 1,
    migrate(manifest) {
      return { ...(manifest as Record<string, unknown>), contractVersion: 1 };
    },
  },
  // EXAMPLE STUB — the pattern for a future v2 (do not uncomment until the
  // contract actually changes; see the checklist in the header comment):
  //
  // {
  //   from: 1,
  //   to: 2,
  //   migrate(manifest) {
  //     const v1 = manifest as Record<string, unknown>;
  //     return {
  //       ...v1,
  //       contractVersion: 2,
  //       // e.g. v2 renames `className` to `wrapperClass`:
  //       // wrapperClass: v1.className,
  //       // className: undefined,
  //     };
  //   },
  // },
];

/**
 * Detect the input's contract version and upgrade it to
 * CURRENT_CONTRACT_VERSION by running the migration chain.
 *
 * Returns:
 *   - `manifest` — the upgraded manifest (the SAME reference when no
 *     migration was needed, so current-version manifests are byte-identical).
 *   - `migratedFrom` — the version the input was detected at when any
 *     migration step ran (0 = versionless), or `null` when the input was
 *     already current (or was not migratable at all).
 *
 * Non-objects, non-numeric versions, and future versions are returned
 * untouched with `migratedFrom: null` — validation reports those precisely
 * (`contractVersion` must equal the current literal), which is a clearer
 * failure than guessing at a migration.
 */
export function migrateContract(input: unknown): { manifest: unknown; migratedFrom: number | null } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { manifest: input, migratedFrom: null };
  }

  const raw = (input as Record<string, unknown>).contractVersion;
  // Missing version = version 0 ("versionless", pre-contract output).
  const detected = raw === undefined ? 0 : raw;
  if (typeof detected !== 'number' || !Number.isInteger(detected) || detected < 0) {
    return { manifest: input, migratedFrom: null };
  }
  if (detected >= CURRENT_CONTRACT_VERSION) {
    // Current (identity path) or future (validation will flag it): untouched.
    return { manifest: input, migratedFrom: null };
  }

  let manifest: unknown = input;
  let version = detected;
  let ran = false;
  // Each step strictly increases `version`, so this terminates; the registry
  // lookup also guards against a malformed registry ever looping.
  while (version < CURRENT_CONTRACT_VERSION) {
    const step = contractMigrations.find((migration) => migration.from === version);
    if (!step || step.to <= version) break; // gap in the chain — stop; validation reports the stale version.
    manifest = step.migrate(manifest);
    version = step.to;
    ran = true;
  }

  return { manifest, migratedFrom: ran ? detected : null };
}
