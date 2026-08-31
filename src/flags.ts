// URL query flags.
//
// Every diagnostic and A/B switch in the demo is a `?name=value` query param,
// read lazily at call time (never cached) so a reload is the only thing needed
// to change one. This module holds the parsing primitives; each system still
// exports its own named reader, so the meaning of a flag lives next to the code
// it configures.
//
// Reading the search string per call is deliberate -- it keeps these usable
// from module scope, from factories, and from the debug console alike.

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** The raw value, or null when the parameter is absent. */
export function raw(name: string): string | null {
  return params().get(name);
}

/** The raw value, or `fallback` when absent. */
export function str(name: string, fallback: string): string {
  return params().get(name) ?? fallback;
}

/**
 * A default-on boolean switch: absent means on, `0` and `false` mean off, and
 * any other value (including an empty `?flag`) means on.
 */
export function enabled(name: string): boolean {
  const q = params().get(name);
  return q === null || (q !== "0" && q !== "false");
}

/** A number, clamped to [min, max]; `fallback` when absent or unparseable. */
export function num(
  name: string,
  fallback: number,
  { min = -Infinity, max = Infinity }: { min?: number; max?: number } = {}
): number {
  const q = params().get(name);
  if (q === null) return fallback;
  const n = Number(q);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** As {@link num}, but parsed with parseInt (accepts a trailing suffix). */
export function int(
  name: string,
  fallback: number,
  { min = -Infinity, max = Infinity }: { min?: number; max?: number } = {}
): number {
  const q = params().get(name);
  if (q === null) return fallback;
  const n = parseInt(q, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** One of a fixed set of string modes; `fallback` for anything else. */
export function oneOf<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  const q = params().get(name);
  return allowed.includes(q as T) ? (q as T) : fallback;
}

/** True when the parameter is exactly `value`. */
export function is(name: string, value: string): boolean {
  return params().get(name) === value;
}
