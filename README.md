# sea-test

A real-time three.js scene: a scattering sky, volumetric clouds, and an FFT
ocean, with TAA, screen-space reflections, cloud shadows, god rays and bloom.

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
  taa/                    temporal antialiasing
  render/                 post pipeline, god rays, scene capture
```

Modules are factory functions returning a "rig" object; there are no classes.
The rig types are `ReturnType<typeof createX>` aliases, so they cannot drift
from the factories.

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

That pauses the loop, clears temporal history and renders 90 frames of exactly
1/60 s from t = 0. Repeat captures are then bit-identical, which makes a
screenshot diff a real regression test.

Two other probes live in `scripts/`:

- `probe-shader-patches.js` — asserts the two shader string-surgery patches
  still find their targets. Run it after any three.js upgrade.
- `dump-shaders.js` — hashes the composed source of every material, so a
  shader refactor can be proven byte-identical rather than eyeballed.
