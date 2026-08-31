// The weighted step list behind the "Generating Assets" bar.
//
// Each step is a resumable bake (loading/types.ts) plus a relative `weight`.
// The bakes report progress within themselves; the loader turns that into one
// monotonic 0..1 by charging each step its share of the total weight. The
// caller builds the list from the same flag readers the factories use, so a
// `?clouds=0` run does not reserve a fifth of the bar for work it will skip.

import { runStep } from "./scheduler.js";
import type { Bake, Progress } from "./types.js";

export interface Step<T = unknown> {
  /** Fallback name, used before the bake yields a label of its own. */
  label: string;
  /**
   * Relative cost. These are measured estimates rather than predictions --
   * `?loading=debug` prints the actual per-step milliseconds so they can be
   * re-tuned against a real machine.
   */
  weight: number;
  /** Built lazily: a step must not start work until its turn comes. */
  bake: () => Bake<T>;
}

export interface StepTiming {
  label: string;
  ms: number;
  weight: number;
}

/** Global fraction for `index` steps done plus `fraction` of the current one. */
export function weightedFraction(
  weights: readonly number[],
  index: number,
  fraction: number
): number {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return index >= weights.length ? 1 : 0;
  let done = 0;
  for (let i = 0; i < index && i < weights.length; i++) done += weights[i];
  const current = index < weights.length ? weights[index] * clamp01(fraction) : 0;
  return clamp01((done + current) / total);
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

export interface RunOptions {
  /** Called with the global 0..1 and the step's own progress report. */
  onProgress(pct: number, p: Progress): void;
  /**
   * Called with each step's result the moment it lands. Later steps read the
   * earlier rigs, so the caller wires them up here rather than after the run.
   */
  onValue(step: Step, value: unknown): void;
  /** Called as each step completes, with its measured cost. */
  onStep?(timing: StepTiming): void;
}

/**
 * Runs the steps in order, yielding to the browser inside each. A step whose
 * bake returns a promise (shader compilation) is awaited before the next one
 * starts, and its wait counts toward its measured cost.
 */
export async function runSteps(
  steps: readonly Step<any>[],
  { onProgress, onValue, onStep }: RunOptions
): Promise<void> {
  const weights = steps.map((s) => s.weight);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    onProgress(weightedFraction(weights, i, 0), { label: step.label, fraction: 0 });
    const started = performance.now();
    const value = await runStep(step.bake(), (p) =>
      onProgress(weightedFraction(weights, i, p.fraction), p));
    onStep?.({ label: step.label, ms: performance.now() - started, weight: step.weight });
    onValue(step, value);
  }
  onProgress(1, { label: "Ready", fraction: 1 });
}
