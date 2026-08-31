// The progress protocol shared by every resumable asset bake.
//
// The expensive CPU bakes (cloud volumes, ocean detail, blue noise, the FFT
// spectra) are written as generators that yield one of these partway through
// their loops. `fraction` is progress *within the yielding step*, 0..1 -- the
// loader owns the weighting that turns those into a global percentage, because
// only it knows which subsystems the URL flags left enabled.
export interface Progress {
  /** Human-readable step name, e.g. "Cloud volume noise". */
  label: string;
  /** Optional finer detail, e.g. "slice 74/128". */
  detail?: string;
  /** Progress within this step, 0..1. */
  fraction: number;
}

/** A resumable bake: yields progress, returns the built asset. */
export type Bake<T> = Generator<Progress, T, void>;
