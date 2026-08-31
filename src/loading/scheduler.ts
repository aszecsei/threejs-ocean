// Driving resumable bakes.
//
// Every expensive bake is a generator (see loading/types.ts). Two ways to run
// one: `drain` burns it down in a single blocking task -- what the synchronous
// wrappers and the node-side tests use -- and `runStep` pumps it against a
// frame budget, handing the main thread back often enough that the loading
// screen keeps painting.

import type { Bake, Progress } from "./types.js";

/** Resolves on the next animation frame. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Runs a bake to completion in one task and returns its value. */
export function drain<T>(bake: Bake<T>): T {
  let step = bake.next();
  while (!step.done) step = bake.next();
  return step.value;
}

/**
 * Composes a sub-bake into a slice of the caller's own 0..1 range, relabelling
 * it. Use it wherever one step is built from several smaller bakes, so the
 * fraction the loader sees stays monotonic across the seam. `detailPrefix`
 * distinguishes two phases of one step that would otherwise both count rows,
 * and so appear to run backwards.
 */
export function* band<T>(
  bake: Bake<T>,
  label: string,
  lo: number,
  hi: number,
  detailPrefix?: string
): Bake<T> {
  let step = bake.next();
  while (!step.done) {
    const detail = step.value.detail;
    yield {
      label,
      detail: detailPrefix ? (detail ? `${detailPrefix} ${detail}` : detailPrefix) : detail,
      fraction: lo + (hi - lo) * step.value.fraction,
    };
    step = bake.next();
  }
  return step.value;
}

/**
 * Runs a bake, yielding to the browser whenever `budgetMs` of uninterrupted
 * work has gone by. `onProgress` sees every yielded Progress, including the
 * ones that did not trigger a frame -- the overlay coalesces them itself.
 */
export async function runStep<T>(
  bake: Bake<T>,
  onProgress: (p: Progress) => void,
  budgetMs = 10
): Promise<T> {
  let started = performance.now();
  for (;;) {
    const step = bake.next();
    if (step.done) return step.value;
    onProgress(step.value);
    if (performance.now() - started >= budgetMs) {
      await nextFrame();
      started = performance.now();
    }
  }
}
