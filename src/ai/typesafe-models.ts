/**
 * Client-safe TypeSafe model pins. Zero node imports: safe to import from
 * browser bundles. The dispatch machinery stays in systemone-transport
 * (server-only); this file carries only the frozen evaluated pin and the
 * known-good list the Settings UI displays.
 */

/** The evaluated model pin — the only known-good pin (see systemone-transport). */
export const TYPESAFE_EVALUATED_MODEL = 'jev-1.13.0';

/**
 * Canonical versioned pins this integration treats as known-good. Only the
 * evaluated pin (`jev-1.13.0`) is a known pin; `jev-latest`/`jev-preview`
 * are documented aliases recorded verbatim in provenance when discovered —
 * never known pins.
 */
export const TYPESAFE_KNOWN_MODELS: ReadonlyArray<string> = [
  TYPESAFE_EVALUATED_MODEL,
] as const;
