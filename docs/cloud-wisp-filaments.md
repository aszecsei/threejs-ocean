# Cloud edges: from crumbs to filaments

Status: not started. Follow-up to the wisp band landed in `src/clouds/shaders/density.glsl`.

## What we have

The wisp band perturbs the shape signal `d0` ahead of the erosion, in a domain
`wispQ` built from the detail domain at `WISP_SCALE` (2.0), a swizzle and
offset, a stronger curl warp (`WISP_CURL`) and a fixed vertical squash
(`WISP_SQUASH`). See `cloudNoiseCoordinates` and the block just above
`float d1=d0;`.

The result is a crumbly fringe: isotropic crumbs and gaps at roughly one wisp
cell (~6 world units) around every edge. The reference photo has that, but
its most characteristic feature is different: filaments drawn out along a
direction, several cells long and about one cell wide, that thin toward their
tips. The current band cannot make those, for three reasons.

1. **The noise is isotropic.** Inverted Worley is round cells; the only
   anisotropy is the vertical squash, which flattens crumbs into lenses but
   does not stretch them along anything.
2. **The curl warp is too small to draw a cell out.** `CURL_STRENGTH*WISP_CURL`
   is about one wisp cell of displacement, and the curl field varies over
   `q.xz*0.35`, i.e. hundreds of units. Across one cell it is nearly constant,
   so it translates crumbs rather than shearing them into tendrils.
3. **The perturbation is symmetric in the shape signal.** A filament is a
   region that *survives* erosion while its neighbours do not; that needs
   the survival to be correlated along a line, which no amount of strength
   on an isotropic field gives.

## What is needed

### 1. Stretch the wisp domain along the local wind

Cirrus already does this (`cirrus.glsl`: the basis lookup happens in a
wind-aligned frame, stretched `CIRRUS_STRETCH` along the wind). Do the same
for the wisp domain:

- Rotate `wispQ.xz` into the wind frame (`WIND_DIR` is a constant in
  `density.glsl`; the low-layer wind is fixed, so the rotation is a constant
  `mat2` define like `CIRRUS_WIND_ROT`).
- Compress the along-wind axis by a `WISP_STRETCH` factor (start at 4; the
  reference filaments are roughly 4-6 cells long).
- Keep the vertical squash. The result is cells that are long along the
  wind, short across it, and flat.

Cost: a `mat2` multiply per wisp sample. Nothing else in the density
function changes.

### 2. Make the stretch follow the local flow, not a global direction

A global stretch gives every filament the same heading, which reads as
combed hair. Real tendrils follow the local shear around each billow.
Two options, in order of cost:

- **Cheap:** rotate the wind frame per sample by the curl field's XY
  direction (already sampled for `curl`): `angle = atan(curl.y, curl.x)`,
  weighted by height so tops streak less than bases. One `atan` per sample.
- **Better:** derive the stretch direction from the gradient of the base
  shape signal (the direction "out of the cloud"). Filaments in the photo
  peel *away* from the mass, so stretching along the outward gradient in the
  horizontal plane is closer to the physics. That needs a gradient of `d0`,
  which is two to three extra base-noise fetches per wisp sample. Only pay
  this inside the shell (the `shell>0` gate already exists) and only in the
  refinement pass (`#ifdef CLOUD_REFINE`), where edges are all that is
  marched.

### 3. Asymmetric survival: thin toward the tip

Real filaments taper. After the stretched perturbation, multiply the
upward push (`delta>0.0` branch, currently `WISP_PUFF`) by a falloff along
the stretched axis: `fract(wispQ_stretched.x)` remapped so a cell's density
peaks at its root and fades to zero at its downwind end. This is what turns
a stretched crumb into a tendril with a tip.

### 4. Second, finer octave only in the refinement pass

The half-res march cannot resolve anything under ~2 px, and the temporal
prefilter (`resolve.frag.glsl`, `preNoise`) deliberately averages
high-variance edge pixels. The refinement pass has none of that constraint.
Add a second wisp octave at `2*WISP_SCALE`, half strength, gated by
`#ifdef CLOUD_REFINE`. The two passes then differ in the fringe, which is
exactly what the edge weight blends between; the coarse structure they share
is what keeps the seam invisible.

## What to watch

- **Tiling.** The wisp domain reads the 64³ detail volume; at 2.0 scale it
  repeats every ~44 world units, and a stretch of 4 makes the repeat ~11
  units across the wind. If banding shows, the fallback is a dedicated 64³
  bake with periods 5/9/14 through `bakeTexture` in `noise-textures.ts`, with
  the determinism and tileability tests from `test/noise.test.ts` extended
  to the new periods.
- **The coarse envelope.** Everything the wisp band adds must stay inside
  `d0>0`; the shadow map and the occupancy prepass bound on that. The
  `d0>0.0` gate in the wisp block is what guarantees it. Do not relax it to
  grow filaments *outside* the base shape; widen `OCCUPANCY_MARGIN` and the
  base shape instead.
- **Rim weighting.** `CloudSample.wispness` is what the rim term lights.
  Tendrils are exactly where it should be strongest, so once they exist,
  re-tune `RIM_STRENGTH` (currently 0.25) against a backlit capture
  (`?cam=0,3,-500&look=0,50,-560&sun=14,-8`).

## Verification

- Capture the near backlit view above with `?cloud-wisp=0` and `=1`; the
  fringe on the small satellite clouds should show elongated tendrils, not
  round crumbs.
- `?cloud-occupancy=0` vs on must still differ only by sample-phase noise
  (run `scratchpad`-style diffs, or `capture-frame.js` twice and compare).
- `scripts/measure-frame-time.js`: the gradient variant should add under
  0.3 ms at 1280×720; anything more means it leaked out of the shell gate.
