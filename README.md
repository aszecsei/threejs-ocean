# sea-test

A real-time three.js scene: a scattering sky, volumetric clouds, and an FFT
ocean, with TAA, screen-space reflections, cloud shadows, god rays and bloom.
The camera can go under the water, where the sea becomes a participating
medium with Snell's window overhead, sun shafts, and caustics on a seabed.

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production bundle into dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## Layout

Each rendering system owns a directory, with its shaders beside it.

```
src/
  main.ts                 scene assembly, lights, and the frame loop
  flags.ts                URL query parsing (see Flags below)
  loading/                the "Generating Assets" screen and its scheduler
  core/
    types.ts              Uniform<T>, Defines, and the shared rig vocabulary
    demo-handle.ts        the window.__demo contract used by scripts/
  math/noise.ts           CPU noise kernel: perlin, worley, curl, blue noise
  shaders/common/         GLSL chunks shared across systems
  sky/                    scattering sky dome + its CPU mirror
  clouds/                 raymarched cloud dome
    temporal/             reprojection and blur of the cloud buffer
    shadows/              top-down cloud shadow map
  ocean/                  displaced surface, SSR, foam
    fft/                  the wave simulation (spectrum, butterfly, cascades)
    underwater/           the water body: medium, mask, resolve, caustics
  seabed/                 the sea floor the caustics land on
  taa/                    temporal antialiasing
  render/                 post pipeline, god rays, scene capture
```

Modules are factory functions returning a "rig" object; there are no classes.
The rig types are `ReturnType<typeof createX>` aliases, so they cannot drift
from the factories.

## Startup

Building the scene takes seconds — most of it the 128³/64³ cloud volumes, then
the FFT cascades and the 512² ocean detail texture. That work happens behind a
"Generating Assets" screen (markup in `index.html`, driven by `loading/`), which
splits diagonally and slides away once the scene is built, compiled, and warmed
up for 45 hidden frames so TAA has converged.

The bakes are written as generators that `yield` a `Progress` partway through
their loops, so `loading/scheduler.ts` can hand the main thread back and the
screen stays live. Every one keeps a synchronous wrapper (`createX` calls
`drain(buildX(...))`), which is what the pure-CPU tests and the rig type aliases
use — so chunking a bake never changes its signature, its type, or its bytes.

Because construction is now asynchronous, `window.__demo` does not exist at
module-evaluation time. Tooling must await **`window.__demoReady`**, which
resolves after the overlay has left the DOM.

## Shaders

GLSL lives in `.glsl` files. `vite-plugin-glsl` resolves `#include`, which is
how shared chunks (the TAA output contract, the cloud density field, the
full-screen vertex shader) reach the shaders that need them.

Two things are assembled in TypeScript rather than included, both deliberately:

- **`SKY_COLOR_GLSL`** — its numeric constants are generated from `SKY_CONSTS`
  in `sky/index.ts`, which is the same object the CPU mirror (`skyPhysicalJS`)
  reads. That shared source is the only thing keeping the GPU sky and the
  CPU-derived fog, background and light colors describing one atmosphere.
  `test/sky.test.ts` guards it. Shaders that use it are split into a
  `.uniforms.glsl` and a `.main.glsl` at that seam.
- **`ocean/fft`'s pass shaders** — they bake `GPUComputationRenderer` variable
  names into `texture2D` calls, so they stay template functions.

Two places rewrite three.js's own shader source by literal string match:
`attachCloudShadow` (which patches the `lights_fragment_begin` chunk so only
the key light is shadowed) and TAA's `trackObject`. Both are **silent** on
failure — `String.replace` with a missing needle is a no-op, the shader still
compiles, and the feature just disappears. Run the probe below after any
three.js upgrade.

## Underwater

Everything below the waterline is `ocean/underwater/`, and none of it runs
while the camera is clear of the surface.

The optics come from two papers in `docs/`. **Monzon et al. (CEIG 2023)**
splits in-scattering in two: substituting the oceanographic downwelling law
`E_D(y) = E_D0 e^(-Kd y)` collapses the multiple-scattering integral into a
closed form, evaluated once per pixel, and that is the whole dark blue fog.
Single scattering — the sun shafts — still has to be marched.
**Papadopoulos & Papaioannou (GraphiCon 09)** supplies the caustics, as a
photon grid splatted from light space; here that is a `THREE.Points` draw,
since WebGL2 has no geometry shader and does not need one.

Three things carry the state, and it matters which answers what:

- **The water mask** — the ocean mesh alone, drawn with its own vertex shader
  and back faces on. A surface met from below puts the ray in water, one met
  from above puts it in air. This is the per-pixel authority.
- **The height probe** — one texel read out of the FFT displacement target,
  giving the true wave height under the camera. `sampleSwell` is out by over
  a metre against the real field (measured), which is fine for bobbing the
  knot and useless for placing a waterline.
- **`sampleSwell`** — still decides whether the passes run at all, with a
  generous margin, because that question tolerates being wrong.

The waterline itself is modelled as a camera port of finite radius. A pinhole
has no waterline: it is above the surface or below it and the image flips in
one frame. Giving it a width makes the crossing an over-under shot, with the
lower half of the frame wet while the water is partway up the glass.

Two deliberate omissions. Scene lights are **not** dimmed with camera depth
(the usual trick): the only lit object is the knot, which floats *at* the
surface and is lit correctly there — what makes it dark from below is the
water between it and the eye, which the resolve pass already applies. And the
ocean surface still does not refract from above, so the seabed never shows
through it; that is the existing shading model, not something the seabed
changed.

## Flags

Everything diagnostic is a URL query parameter, read fresh on every call.

| Flag | Effect |
| --- | --- |
| `?dpr=<x>` | Override device pixel ratio (perf attribution, not quality) |
| `?taa=0\|velocity\|history\|reactive` | Disable TAA, or show a diagnostic view |
| `?bloom=0\|<k>` | Disable or scale bloom |
| `?sun=<elev>[,<azim>]` | Move the sun, in degrees |
| `?sky-lut=0` | Evaluate the grade sky per pixel instead of the baked LUT |
| `?ocean=0` | Replace the ocean with a flat grid |
| `?ocean-n=128\|256\|512` | FFT resolution |
| `?detail=0` `?contact=0` `?cascade2=0` | Drop detail texture / contact foam / fine cascade |
| `?ssr=0\|full` | Disable SSR, or march every ray instead of gating on the knot |
| `?clouds=0` `?cirrus=0` | Drop the cloud dome / the cirrus layer |
| `?cloud-res=<n>` | Offscreen cloud divisor; `0` renders the dome in-scene |
| `?cloud-debug=<mode>` | Cloud debug views (`coverage`, `shadow`, `history`, …) |
| `?cloud-temporal=0\|interleaved` | Cloud reprojection mode |
| `?rays=0\|<k>\|debug` | Disable, scale, or inspect the god-ray mask |
| `?loading=0\|debug` | Skip the loading screen, warm-up and reveal / print the per-step cost table |
| `?loading-hold=1` | Hold the finished loading screen up until `__demo.loading.finish()` |
| `?cam=<x,y,z>` `?look=<x,y,z>` | Place the camera and its orbit target |
| `?underwater=0` | Disable the whole underwater system (the sea vanishes from below, as it used to) |
| `?water=I\|II\|3C` | Jerlov medium preset: clearest ocean, clear ocean, coastal |
| `?shafts=0\|<n>` | Disable single scattering, or set its step count |
| `?caustics=0` | Drop the caustic map; shafts and sand go smooth |
| `?meniscus=0` | Drop the waterline film |
| `?seabed=0` `?seabed-depth=<m>` | Drop the sea floor, or move it (default 10) |
| `?underwater-debug=mask\|depth\|caustics` | Underwater diagnostic views |

Note two intentional quirks, both covered by tests: `?cascade2` accepts only
`0` (not `false`), and an empty value such as `?bloom=` parses as `0`, not as
the default.

## Verifying a change

The scene animates and TAA accumulates, so naive screenshots of an unchanged
build differ by ~10/255 — more than most real regressions. `window.__demo`
exposes a fixed-step clock to remove that:

```js
// via playwright-cli eval, against a running dev server
() => import('/scripts/capture-frame.js').then(m => m.default())
```

That awaits `window.__demoReady`, pauses the loop, clears temporal history and
renders 90 frames of exactly 1/60 s from t = 0. Repeat captures then agree to
within 1/255 on a handful of samples (measured; the FFT foam accumulator is the
residue `resetTemporal` does not clear), which makes a screenshot diff a real
regression test. Awaiting the handle is also what guarantees the loading screen
is gone from the DOM before the shot is taken.

It honors `?cam=` and `?look=`, which is how an underwater viewpoint is
reached reproducibly. Landing a shot *on* the waterline needs the real wave
height, which only the FFT knows — take it off the handle:

```js
() => window.__demo.submersion.waterY   // then pass it back as ?cam=x,<that>,z
```

Two other probes live in `scripts/`:

- `probe-shader-patches.js` — asserts the two shader string-surgery patches
  still find their targets. Run it after any three.js upgrade.
- `dump-shaders.js` — hashes the composed source of every material, so a
  shader refactor can be proven byte-identical rather than eyeballed.
