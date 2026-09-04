# Occupancy prepass: span-scaled step sizing

Status: not started. Follow-up to the occupancy prepass in
`src/clouds/occupancy/` and `occupancyNarrow` in `march.core.glsl`.

## What we have

The prepass records, per 8×8-pixel tile, the first and last slab distance
at which coarse density was found. `occupancyNarrow` clamps a ray's
`[t0, t1]` to the 3×3-tile union of those spans and collapses it to nothing
on an empty tile.

The march's step size is deliberately **not** derived from the narrowed
span. `march.main.glsl` and `refine.frag.glsl` compute
`baseStep = (t1 - t0) / PRIMARY_STEPS` from the *un-narrowed* slab and pass
it in; the narrowing only moves the loop's start and its break point. This
was a landing decision: with the sampling rate unchanged, `?cloud-occupancy=0`
against on differs only by sample-phase noise, which made it a pixel-level
regression test for prepass misses. It held (0.66% of pixels over 2/255, all
inside cloud bodies, no missing shapes).

The cost of that decision is that the prepass only saves iterations; it never
*spends* them. A ray whose span is a tenth of the slab still marches at the
slab's step size and finishes in a tenth of the iterations. The budget it
freed goes unused, when it could buy finer sampling on exactly the rays that
have cloud in them.

## What is needed

### 1. Scale the step to the span, with a floor

```glsl
float slabStep = (slabT1 - slabT0) / float(PRIMARY_STEPS);
float spanStep = (t1 - t0) / float(PRIMARY_STEPS);
float baseStep = max(min(slabStep, spanStep), OCCUPANCY_MIN_STEP);
```

- `min(slabStep, spanStep)`: never coarser than today.
- `OCCUPANCY_MIN_STEP` (start at `len(0.05)`, 3 world units): a short span
  must not turn into 160 samples of a 0.2-unit stride. Below the floor the
  loop breaks early on `t > t1` as it does now, so the cost is bounded either
  way.
- Behind a define `OCCUPANCY_SPAN_STEPS` so it can be compiled out, and a
  flag (`?cloud-span-steps=0`) documented in the README flag table like the
  others.

The energy of the march does not depend on step size in expectation
(emission-absorption integrates `1 - exp(-d*ext*step)` per step), so a
finer stride changes the noise, not the mean. Both temporal accumulators
average the noise.

### 2. The real risk: the span is piecewise-constant per tile

The narrowed span, and so the step size, is constant across an 8×8-pixel
tile and jumps at tile borders (the 3×3 gather softens but does not remove
this). Different step sizes give different noise character, and a grid of
noise-character changes is visible as blocks in the stochastic fringe
before the temporal history converges, and permanently in anything the
history rejects (disocclusion, fast motion).

Mitigations, cheapest first:

- **Quantise the step, not the span.** Round `baseStep` to a power-of-two
  fraction of `slabStep` (`slabStep / 2^k`). Neighbouring tiles then either
  share a step or differ by exactly 2×, and 2× steps interleave (the
  blue-noise jitter is scaled by `fineStep`, so the sample sets nest). This
  is the same reasoning as mip levels.
- **Bilinear span.** Sample the occupancy map with `texture()` at the tile
  centre offsets instead of `texelFetch` and let the span interpolate. The
  target is `NearestFilter` for a reason (filtering an `[entry, exit]` pair
  invents spans neither neighbour has), so keep `texelFetch` for the
  *bounds* and add a second, `LinearFilter` read only for the *step size*.
  The step then varies smoothly across the tile.
- **Clamp the ratio.** Limit `slabStep / baseStep` to 4. Beyond that the
  noise-character difference between neighbouring tiles is too large for
  the resolve's 3×3 clamp to hide.

### 3. Spend it where it counts: the refinement pass first

The half-res dome pass feeds the temporal resolve, whose variance-guided
prefilter is tuned for the current noise level. Changing that noise floor
means re-tuning `preNoise` and `boxNoise` in `resolve.frag.glsl`. The
refinement pass has its own simpler history (`refine-resolve.frag.glsl`)
and marches only edge pixels, which are where finer sampling shows. Land
span-scaled steps under `#ifdef CLOUD_REFINE` first, measure, then decide
whether the dome pass wants it too.

### 4. Light march budget

Finer primary steps mean more light marches per ray (one per non-empty fine
sample). `LIGHT_REUSE` (`?cloud-light`) caches the light march for two
samples; with span-scaled steps that cadence should scale with the step
ratio (`odAge` threshold = `2 * slabStep / baseStep`, clamped), or the cost
grows faster than the quality.

## Verification

- `?cloud-span-steps=0` vs on at `?cam=0,3,0&look=0,35,-60`: same shapes,
  finer fringe, and **no visible 8-pixel grid** in `?cloud-debug=refined`
  after a `resetTemporal()` and one frame (that is the worst case, before
  history converges). Also check the first frame after a camera cut.
- `?cloud-debug=occupancy` unchanged (the prepass itself does not move).
- `scripts/measure-frame-time.js` at 1280×720, sky view: the target is
  no slower than today's 3.82 ms with all defaults on. If it is slower, the
  floor is too low or the light-march cadence did not scale.
- `capture-frame.js` twice in a row must still agree within 1/255; a
  step size that depends on a bilinear span read must not introduce any
  frame-to-frame instability of its own.
