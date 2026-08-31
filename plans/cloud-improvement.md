# Cloud rendering improvement plan

## Goal

Bring the cloud renderer closer to the shaping, lighting, and reconstruction methods described in `notes/real-time volumetric cloud rendering — Nubis and Red Dead Redemption 2.md` without losing the current afternoon palette, ocean integration, or diagnostic fallbacks.

The work covers six changes:

1. Put the vertical profile inside density formation.
2. Separate coverage from cloud type.
3. Replace expensive procedural noise evaluation with generated 3D textures.
4. Add cloud-specific temporal reconstruction.
5. Use coarse surrounding density for ambient light.
6. Add world-space cloud shadows.

Each change should land behind an A/B query switch until its visual and performance checks pass. Do not tune several shaping parameters at once. The existing shader has tightly coupled constants, so structural changes and look tuning must remain separate steps.

## Constraints

- Preserve `?clouds=0`, `?cloud-res=0`, `?cloud-light=0`, `?cloud-far=0`, `?taa=0`, and `?rays=debug`.
- Keep the cloud layer in world space and preserve camera parallax.
- Keep all cloud, sky, ocean, and shadow calculations in linear light. Tone mapping remains in `post.js`.
- Keep dense cloud interiors lighter than the zenith sky. Dark blue interiors read as holes in the sky in this palette.
- Keep cloud color premultiplied in offscreen buffers.
- Avoid changing the sky palette, sun direction, ocean shading, and cloud structure in one patch.
- Keep a fallback for devices that cannot provide the required WebGL2 texture or MRT capabilities.
- Validate performance on a real GPU. The headless browser's FPS counter is useful for catching gross regressions, not for final timing.

## Notation

| Symbol | Meaning |
| --- | --- |
| `p` | World-space sample position |
| `h` | Normalized height inside the local cloud column |
| `C(xz)` | Artist-facing coverage amount in `[0, 1]`; larger means more cloud |
| `T(xz)` | Continuous cloud-type control in `[0, 1]` |
| `G(h, T)` | Vertical cloud profile |
| `P(p)` | Dimensional profile, combining coverage and vertical profile |
| `N_b(p)` | Low-frequency base noise |
| `N_d(p)` | High-frequency detail noise |
| `D(p)` | Final density |
| `sigma_ext` | Extinction coefficient |
| `Delta s` | Ray-march step length |
| `tau` | Optical depth |
| `Tr` | Transmittance |
| `mu` | Cosine of the angle between view and sun directions |

The common remap operation is

```text
remap(v, a, b, c, d) = c + (v - a) / (b - a) * (d - c)
```

Clamp the result where the caller expects a value in `[0, 1]`. Protect every denominator with a small epsilon.

## Baseline and rollout controls

Before changing density, add enough instrumentation to compare each phase against the current renderer.

- [ ] Add `window.__demo.clouds` in `main.js`, exposing the cloud rig, active render targets, reset functions, and active diagnostic mode.
- [ ] Add a `?cloud-debug=` selector in `clouds.js`. Reserve these modes:
  - `profile`
  - `coverage`
  - `type`
  - `base-noise`
  - `detail-noise`
  - `coarse-density`
  - `cloud-depth`
  - `cloud-reactive`
  - `shadow`
- [ ] Capture fixed-camera baseline images for the default horizon view and an upward view. Use `window.__demo.camera` for repeatable positioning.
- [ ] Record baseline FPS at `?dpr=1`, default DPR, `?cloud-res=0`, and `?taa=0`.
- [ ] Record the current cloud constants and query string with each baseline image.
- [ ] Check the browser console and `renderer.getContext().getError()` after each diagnostic mode.

The six feature switches should be:

```text
?cloud-profile=legacy|dimensional
?cloud-weather=coupled|split
?cloud-noise=procedural|texture
?cloud-temporal=0|full|interleaved
?cloud-ambient=legacy|coarse
?cloud-shadows=0|1|debug
```

Use the new path by default only after its phase-specific exit criteria pass.

---

## 1. Put the vertical profile inside density formation

### Purpose

The current shader thresholds the base noise and then multiplies the result by the height profile:

```text
B = smoothstep(c, c + w, N_b)
D_current = B * G * densityGain
```

This makes the cloud base and top fade uniformly in opacity. Nubis instead uses coverage and profile to decide which portions of the noise survive. That shrinks the occupied region near the base and top while preserving dense cores.

### Target formula

During this phase, convert the existing threshold `c` into an artist-facing coverage amount:

```text
C = saturate(1 - c)
P = saturate(G(h, T) * C)
shapeThreshold = 1 - P
D_0 = smoothstep(shapeThreshold, shapeThreshold + w, N_b)
```

At `G = 1`, this is equivalent to the existing threshold because `shapeThreshold = c`. At partial profile values, the threshold rises rather than merely reducing opacity.

Apply detail erosion after dimensional shaping:

```text
e = E * erosionSignal(N_d) * (1 - D_0)
D_1 = saturate(remap(D_0, e, 1, 0, 1))
D = D_1 * lerp(cumulusGain, towerGain, tower)
```

The `(1 - D_0)` factor protects the dense core. Keep extinction separate from density gain:

```text
Delta tau = D * sigma_ext * Delta s
Tr_step = exp(-Delta tau)
```

### Implementation steps

- [ ] Refactor `cloudDensityEx()` in `clouds.js` into clearly ordered calculations for local height, profile, coverage, base noise, dimensional shaping, erosion, and density gain.
- [ ] Retain the current `cuProfile` and `cbProfile` during this phase. Changing the profile curves and changing how they enter density in the same patch would make comparison difficult.
- [ ] Replace `d *= profile` with `P = profile * C` and the `1 - P` threshold shown above.
- [ ] Make coarse probes and fine samples use the same dimensional profile. They may differ in noise octaves and erosion, but they must not disagree about the cloud envelope.
- [ ] Return local normalized height and profile from the shared density calculation where later lighting phases will need them.
- [ ] Add `?cloud-debug=profile` to display `G` and `?cloud-debug=coverage` to display `C`.
- [ ] Keep `?cloud-profile=legacy` until the new path has been tuned and checked.
- [ ] Tune only the remap width `w` first. Then tune coverage. Change density gain or extinction only if opacity still differs after those two are stable.

### Validation

- The cloud base and top should contract into the noise instead of appearing as translucent horizontal sheets.
- Dense cores should remain at least as opaque as the legacy path.
- The broad cloud count and horizon composition should remain close to the baseline.
- Coarse probing must not skip fine density. In a density diagnostic, every fine cloud region must lie inside or very near a coarse-positive region.
- `?cloud-profile=legacy` must reproduce the baseline within normal temporal variation.

### Main risk

The new profile raises the threshold sharply near the vertical boundaries. Existing coverage values were tuned for post-threshold multiplication, so the first result may look too sparse. Correct this with the profile remap width and coverage amount before increasing density gain.

---

## 2. Separate coverage from cloud type

### Purpose

The current weather value controls cloud clustering, tower probability, trunk density, and anvil spread. Nubis and HZD keep coverage and cloud type separate so broad cloud amount can change without forcing the same vertical profile.

### Weather fields

Generate two decorrelated low-frequency fields with different seeds or offsets:

```text
n_C = 0.65 * V(w_C) + 0.35 * V(2.3 * w_C + o_C)
n_T = 0.70 * V(w_T) + 0.30 * V(2.1 * w_T + o_T)

C = saturate(remap(n_C, coverageClear, coverageOvercast, 0, 1))
T = saturate(remap(n_T, typeLow, typeHigh, 0, 1))
```

Both fields may translate with the same wind velocity, but they should not share the same noise samples. Keep macro fields stable apart from translation. Only the local detail field should evolve over time.

Gate towers by both type and coverage:

```text
towerType = smoothstep(towerTypeStart, towerTypeFull, T)
towerCoverage = smoothstep(towerCoverageMin, towerCoverageFull, C)
tower = towerType * towerCoverage
```

This prevents a high type value from creating a tower in an otherwise clear region.

### Continuous profiles

Add a lower, broader stratocumulus profile alongside the current cumulus and cumulonimbus profiles:

```text
G_sc(h) = smoothstep(0.00, 0.10, h)
        * (1 - smoothstep(0.45, 0.68, h))

G_cu(h) = smoothstep(0.00, 0.18, h)
        * (1 - smoothstep(0.72, 1.00, h))

G_cb(h) = smoothstep(0.00, 0.06, h)
        * (1 - smoothstep(0.93, 1.00, h))

lowType = smoothstep(typeStratocumulus, typeCumulus, T)
G_low = lerp(G_sc, G_cu, lowType)
G = lerp(G_low, G_cb, tower)
```

These bounds are starting values, not final art direction.

### Nubis-style anvil inflation

Replace the threshold subtraction used for anvil spread with a height-localized coverage exponent:

```text
anvilHeight = smoothstep(0.70, 0.80, h)
anvilExponent = lerp(1.0, lerp(1.0, 0.5, anvilBias), anvilHeight * tower)
C_anvil = pow(max(C, epsilon), anvilExponent)
```

For coverage in `(0, 1)`, an exponent below one increases coverage. Feed `C_anvil` into the dimensional profile:

```text
P = G * C_anvil
D_0 = smoothstep(1 - P, 1 - P + w, N_b)
```

Keep the existing altitude-dependent shear as a separate geometric control.

### Implementation steps

- [ ] Change `weather()` in `clouds.js` to return independent coverage and type values.
- [ ] Use separate coordinate offsets and octave weights for the two fields.
- [ ] Keep both macro fields on the same world-space wind velocity so cloud formations do not tear apart while moving.
- [ ] Add the stratocumulus profile and continuous profile selection.
- [ ] Derive tower weight from type multiplied by a coverage gate.
- [ ] Move anvil inflation into `C_anvil` using the exponent formula above.
- [ ] Keep tower height, turret variation, anisotropic noise scaling, and static anvil shear separate from coverage.
- [ ] Add `?cloud-debug=type` with a visible low-to-high color ramp. Coverage and type diagnostics must show different patterns.
- [ ] Add constants for coverage remap, type remap, tower gate, and anvil bias. Do not leave numeric thresholds embedded inside `weather()`.
- [ ] Preserve `?cloud-weather=coupled` for comparison.

### Validation

- High coverage with low type should produce a broad, lower layer rather than towers.
- High type with low coverage should remain mostly clear.
- Mid type should blend between stratocumulus and cumulus without a visible profile pop.
- Tower anvils should spread near the top without widening the entire trunk.
- Coverage and type should advect together without sharing identical contours.
- Cloud macro placement should remain coherent while fine detail evolves.

### Main risk

Independent random fields can produce visually arbitrary combinations. The tower coverage gate and similar spatial scales keep the combinations plausible. If the fields still look unrelated, correlate them weakly rather than making them identical:

```text
T_correlated = lerp(T_independent, C, correlation)
```

Start with `correlation` near `0.2`.

---

## 3. Replace procedural noise with generated 3D textures

### Purpose

A fine density sample currently evaluates five octaves of value noise and two 27-cell Worley searches. Light samples add more procedural value noise. HZD stores a compact Perlin-Worley base and Worley detail in 3D textures, which moves repeated neighborhood work out of the fragment shader and gives more control over connected cloud bodies.

### Texture contents

Add `cloud-noise.js`, following the deterministic CPU-baking pattern in `ocean-textures.js`.

Start with these textures:

1. A tileable `64^3` RGBA8 base texture.
   - R: Perlin-Worley composite.
   - G: low-frequency inverted Worley.
   - B: medium-frequency inverted Worley.
   - A: high-frequency inverted Worley.
2. A tileable `32^3` RGBA8 detail texture.
   - R, G, B: increasing-frequency Worley detail.
   - A: optional curl magnitude or an extra detail octave.

Benchmark startup time and GPU memory before considering `96^3` or `128^3`. A `128^3` RGBA8 texture uses 8 MiB before driver overhead and is expensive to generate in JavaScript.

### Perlin-Worley construction

Let `N_P` be normalized gradient-noise fBm and `N_W` be normalized inverted Worley. Construct the connected base as:

```text
N_PW = saturate(remap(N_P, 1 - N_W, 1, 0, 1))
```

Equivalently:

```text
N_PW = saturate((N_P - (1 - N_W)) / max(N_W, epsilon))
```

This uses Worley to dilate and carve the connected Perlin body instead of multiplying the two signals and collapsing the dense core.

Combine texture channels into coarse and fine signals:

```text
N_b = base.r
N_w = dot(base.gba, baseWeights)
N_d = dot(detail.rgb, detailWeights)
```

Use the red base channel alone for cheap envelope probes. Use the extra base and detail channels only after a coarse hit.

A density-preserving detail erosion is:

```text
erosionThreshold = E * (1 - N_d) * (1 - D_0)
D_1 = saturate(remap(D_0, erosionThreshold, 1, 0, 1))
```

### Implementation steps

- [ ] Create `cloud-noise.js` with deterministic, tileable 3D gradient noise and Worley generation.
- [ ] Use a fixed seed and wrapped lattice coordinates so texture boundaries tile in all three dimensions.
- [ ] Normalize every stored channel to a predictable `[0, 1]` range before quantization.
- [ ] Create `THREE.Data3DTexture` objects with `RepeatWrapping`, linear filtering, `NoColorSpace`, and no accidental color conversion.
- [ ] Detect the maximum supported 3D texture size and fall back to the procedural path if allocation or shader compilation fails.
- [ ] Create the textures once in `createClouds()` or a small shared resource owner. Add disposal when the renderer is torn down.
- [ ] Add base and detail samplers to the cloud shader and replace `fbm()` and `worleyFbm()` calls in the texture path.
- [ ] Keep coarse density to one base-texture lookup plus profile math.
- [ ] Use the detailed channels only for fine view samples. Light samples should use the red base channel and omit edge detail.
- [ ] Preserve world-space scale, anisotropic tower scaling, wind translation, and domain warp when constructing texture coordinates.
- [ ] Use two decorrelated texture reads if one repeating tile becomes visible. Offset and rotate the second read rather than generating a larger texture immediately.
- [ ] Add `?cloud-debug=base-noise` and `?cloud-debug=detail-noise`.
- [ ] Keep `?cloud-noise=procedural` until visual and startup checks pass.
- [ ] Once the texture path is the default, remove unused procedural GLSL only in a separate cleanup patch.

### Validation

- The texture path should retain connected cloud bodies and cauliflower edge erosion.
- No seams should appear as texture coordinates cross integer tile boundaries.
- Wind motion should not reveal a short, obvious repeat period.
- Coarse and fine density must agree on occupied regions.
- Browser startup time, GPU memory, and frame time should be recorded for each candidate texture size.
- The texture path should reduce cloud shader cost on a real GPU. If it does not, inspect texture bandwidth and cache behavior before increasing resolution.

### Main risks

- A low-resolution 3D texture can show tiling or blocky structures.
- CPU generation can stall startup.
- A large texture can trade arithmetic pressure for bandwidth pressure.

Use the smallest texture that survives the horizon and upward-view checks. Layered, incommensurate coordinates are preferable to a single oversized asset.

---

## 4. Add cloud-specific temporal reconstruction

### Purpose

The global TAA receives cloud alpha as reactivity. Its history trust is therefore approximately

```text
historyTrust = 1 - cloudAlpha
```

Opaque cloud pixels get no temporal accumulation. The cloud pass also does not write representative cloud depth into the main scene depth buffer, so global depth rejection is not a reliable cloud-history test.

Give clouds their own temporal resolve before compositing them into the main frame. This allows cloud depth, opacity, and density evolution to be compared in cloud space. It also makes sparse ray updates practical.

### Raw cloud outputs

Extend the private cloud render target to carry:

```text
attachment 0: premultiplied cloud RGB, opacity
attachment 1: velocity.xy, representative depth, instantaneous reactivity
attachment 2: density signature, valid-sample flag, reserved, reserved
```

Check `MAX_DRAW_BUFFERS` and `MAX_COLOR_ATTACHMENTS` before requiring three attachments. If only two are practical, pack validity and density signature into the second attachment and reconstruct depth from opacity-weighted distance.

Compute representative cloud distance using the current segment contributions:

```text
w_i = Tr_i * (1 - exp(-Delta tau_i))
t_bar = sum(w_i * t_i) / max(sum(w_i), epsilon)
```

The current code already computes this quantity. Store a normalized or view-space form suitable for relative depth comparison.

Cloud motion remains:

```text
p_current = eye + dir * t_bar
p_previous = p_current + previousWindOffset
uv_previous = project(previousViewProjection, p_previous)
velocity = uv_current - uv_previous
```

Include every deterministic macro translation in `previousWindOffset`. Treat unresolved domain evolution as reactivity rather than pretending it has exact velocity.

### Cloud history validation

For a current cloud sample and reprojected history sample:

```text
relativeDepthError = abs(z_current - z_history)
                   / max(min(z_current, z_history), 1)

depthValid = 1 - smoothstep(depthRejectStart,
                            depthRejectEnd,
                            relativeDepthError)

opacityChange = saturate(abs(alpha_current - alpha_history) / alphaThreshold)
densityChange = saturate(abs(rho_current - rho_history) / densityThreshold)
reactive = max(opacityChange, densityChange, instantaneousReactive)

motionTrust = exp(-motionPixels * motionDecay)
historyWeight = historyMax * depthValid * motionTrust * (1 - reactive)
```

Clip reprojected history against the current cloud neighborhood in premultiplied color space:

```text
historyClipped = clamp(history, neighborhoodMin - extent,
                                neighborhoodMax + extent)
resolved = lerp(current, historyClipped, historyWeight)
```

Opacity must be reconstructed and blended with color. Do not resolve straight RGB separately from alpha, since that creates bright fringes around thin clouds.

### Stage A: full low-resolution updates

- [ ] Create `cloud-temporal.js` to own cloud history targets, resolve material, reset logic, and diagnostics.
- [ ] Render every low-resolution cloud pixel each frame, as the current pass does.
- [ ] Resolve cloud color using cloud depth and cloud reactivity before compositing into the scene.
- [ ] Reset cloud history on resize, camera cuts, projection changes, cloud mode changes, and texture regeneration.
- [ ] Add `?cloud-debug=cloud-depth` and `?cloud-debug=cloud-reactive`.
- [ ] Compare camera pans, fast orbiting, resize, and wind motion against `?cloud-temporal=0`.

### Stage B: interleaved updates

After the full-update temporal path is stable, update one pixel in each `2x2` low-resolution block per frame:

```text
phase = frameIndex mod 4
valid = ((x & 1) + 2 * (y & 1)) == phase
```

At the default half-width, half-height cloud target, this casts one cloud ray for every sixteen full-resolution pixels per frame.

- [ ] Mark pixels without a fresh ray as invalid instead of writing transparent cloud data.
- [ ] For an invalid pixel, reproject valid history first. Use current valid neighbors to bound and repair history.
- [ ] If history is invalid, reconstruct from the nearest current samples in the `2x2` block and reduce confidence.
- [ ] Rotate the update phase every frame.
- [ ] Replace static ray-start jitter with a frame-varying blue-noise sequence:

```text
jitter_t = fract(blueNoise(pixel) + frameIndex * goldenRatioConjugate)
goldenRatioConjugate = 0.61803398875
```

- [ ] Feed reconstruction confidence into output reactivity so newly exposed or poorly reconstructed pixels do not leave trails.
- [ ] Add `?cloud-temporal=full` and `?cloud-temporal=interleaved` for direct comparison.

### Integration with global TAA

The cloud-specific resolve should own cloud accumulation. The global TAA should not accumulate opaque cloud pixels a second time.

Output global reactivity as a blend between cloud confidence and opacity:

```text
cloudResolvedReactive = max(cloudChangeReactive, 1 - reconstructionConfidence)
globalReactive = saturate(cloudAlpha
                        + (1 - cloudAlpha) * cloudResolvedReactive)
```

Fully opaque cloud pixels use the already-resolved cloud result. Thin mixed pixels still protect unstable cloud edges while allowing the background contribution to use normal global TAA.

### Validation

- Opaque clouds should become temporally stable without freezing their wind motion.
- No history trail should remain after a camera cut or rapid orbit.
- Thin cloud edges should not develop bright or dark premultiplied-alpha fringes.
- The interleaved path should approach the full-update image after several stationary frames.
- `?taa=velocity`, `?taa=history`, `?taa=reactive`, and the new cloud diagnostics must agree about motion and rejection.
- Measure frame time for full low-resolution updates and interleaved updates on a real GPU.

### Main risk

Procedural clouds do not have one exact surface depth. A single opacity-weighted distance is an approximation. Depth thresholds must allow gradual internal changes while still rejecting disocclusion. Density and opacity change are therefore as important as geometric depth.

---

## 5. Use coarse surrounding density for ambient light

### Purpose

The current ambient term is a height gradient plus fixed sky and sea colors. Interior shadow tint depends on optical depth toward the sun. It does not estimate whether surrounding cloud density blocks sky or ground light.

Use the cheap density representation introduced in phase 3 to estimate local in-scattering and directional ambient visibility.

### Coarse neighborhood density

Sample a small fixed neighborhood using coarse density only:

```text
rho_L(p) = sum(w_k * D_coarse(p + offset_k)) / sum(w_k)
```

Use offsets above, below, toward the sun, and across two horizontal directions. Rotate the horizontal pattern per pixel or reuse it across two fine steps to control cost.

A Nubis-style in-scatter probability is:

```text
heightExponent = remap(h, 0.30, 0.85, 0.50, 2.00)
P_depth = 0.05 + pow(rho_L, heightExponent)
P_vertical = pow(saturate(remap(h, 0.07, 0.14, 0.10, 1.00)), 0.8)
P_inScatter = saturate(P_depth * P_vertical)
```

This should be treated as an artistic probability term, not a physical derivation.

### Directional ambient transmittance

Estimate short optical depths toward the upper sky and lower hemisphere:

```text
tau_up = sigma_ambient * sum(D_coarse(p + up * s_j) * Delta s_j)
tau_down = sigma_ambient * sum(D_coarse(p - up * s_j) * Delta s_j)

Tr_up = exp(-tau_up)
Tr_down = exp(-tau_down)
```

Build ambient radiance from the shared palette:

```text
L_sky = desaturate(skyColorAtHeight, ambientChroma)
L_ground = desaturate(groundColor, groundChroma)

L_ambient = L_sky * Tr_up
          + L_ground * Tr_down
          + L_multiScatterTint * P_inScatter
```

Use the sample's local column height `h`, not `(p.y - CLOUD_BOTTOM) / CU_HEIGHT`. The current calculation clamps every tower sample above the normal cumulus top to the same height value.

### Implementation steps

- [ ] Add a `coarseCloudDensity()` helper shared by view probes, light rays, ambient probes, and the future shadow pass.
- [ ] Define a bounded neighborhood pattern with no more than four additional coarse samples for the first implementation.
- [ ] Compute `rho_L`, `Tr_up`, and `Tr_down` from those samples.
- [ ] Cache the ambient result across two fine view steps, as the direct-light optical depth is currently cached.
- [ ] Replace fixed top fill and sea-bounce constants gradually. Keep the legacy term available during tuning.
- [ ] Derive ambient colors from shared sky uniforms so sun presets and LUT grading remain coherent.
- [ ] Keep the pale-blue dense-interior floor. Apply it after coarse ambient occlusion so the renderer never returns to dark zenith-colored holes.
- [ ] Add `?cloud-debug=coarse-density` and an ambient-only diagnostic.
- [ ] Add `?cloud-ambient=legacy` for A/B comparison.

### Validation

- Cloud cavities and stacked billows should show broader ambient variation, not only direct-sun shadows.
- Cloud tops should stay bright where upper-sky visibility is high.
- Cloud bottoms should retain enough sea bounce for the current afternoon style.
- Dense interiors must remain visibly lighter than the zenith sky in both horizon and upward views.
- Ambient variation should not flicker when view samples cross the coarse-probe pattern.
- The added samples should not erase the performance gained by textured density and temporal interleaving.

### Main risk

Ambient occlusion and direct-sun optical depth can darken the same region twice. Tune `sigma_ambient` and the multi-scatter tint with direct sunlight disabled in a diagnostic, then inspect the combined result.

---

## 6. Add world-space cloud shadows

### Purpose

`godrays.js` darkens a screen-space sun mask and radially blurs it. It does not cast cloud shadows onto the ocean or scene geometry. Add a low-resolution world-space transmittance map so direct sunlight responds to clouds even when the sun or receiver lies outside the screen-space shaft effect.

### Shadow transmittance

For each receiver-plane coordinate `xz`, trace a coarse ray from the receiver toward the sun through the cloud slab:

```text
r(s) = p_receiver + s * sunDirection
```

Intersect this ray with `[CLOUD_BOTTOM, CB_TOP]`, then integrate:

```text
tau_shadow(xz) = sigma_ext * integral(D_coarse(r(s))) ds
T_shadow(xz) = exp(-tau_shadow(xz))
```

The discrete form is:

```text
tau_shadow = sigma_ext * sum(D_coarse(r(s_i)) * Delta s_i)
T_shadow = exp(-tau_shadow)
```

Optionally store transmittance-weighted cloud depth for filtering or future aerial effects:

```text
w_i = Tr_i * (1 - exp(-Delta tau_i))
z_bar = sum(w_i * z_i) / max(sum(w_i), epsilon)
```

An RG16F target can store `T_shadow` and normalized `z_bar`. Start with R16F if depth is not used.

### World mapping

Center the shadow map on the camera or visible ocean disc:

```text
uv = (worldXZ - shadowCenterXZ) / shadowExtent + 0.5
```

Snap the center to shadow texels to prevent swimming:

```text
worldTexel = shadowExtent / shadowResolution
shadowCenterXZ = floor(cameraXZ / worldTexel) * worldTexel
```

Begin with a `256x256` map covering the ocean's visible diameter plus a margin. Increase resolution only after checking projected texel size on the water.

### Shared density code

The view shader and shadow shader must evaluate the same coverage, type, profile, wind, and coarse base density.

- [ ] Extract common GLSL into a generated string module such as `cloud-density.glsl.js`, or build both materials from the same shader chunks in `clouds.js`.
- [ ] Share all cloud geometry and weather uniforms. Do not duplicate constants in `cloud-shadows.js`.
- [ ] Keep detailed erosion out of the shadow pass. Coarse density gives softer, more stable shadows and costs less.

### Shadow pass

- [ ] Create `cloud-shadows.js` to own the shadow render target, orthographic/fullscreen pass, world mapping, temporal state, resize, and disposal.
- [ ] Use 8 to 16 geometrically distributed coarse samples through the cloud slab.
- [ ] Jitter the shadow samples spatially, then stabilize with a small temporal blend or staggered update pattern.
- [ ] Add a separable blur or mip chain only if texel aliasing remains visible. Do not blur before checking whether coarse cloud density already supplies enough softness.
- [ ] Update the snapped world center as the camera moves.
- [ ] Reset shadow history on sun-direction changes, cloud-mode changes, and large camera jumps.
- [ ] Expose `?cloud-shadows=debug` as a fullscreen or HUD overlay.

### Receiver integration

Apply cloud transmittance only to direct sunlight:

```text
L_direct_shadowed = T_shadow * L_direct
L_total = L_direct_shadowed + L_ambient + L_reflection
```

Do not multiply the entire ocean result by the shadow. Reflections, sky ambient, foam emission-like lift, and subsurface terms need separate treatment.

- [ ] Add `tCloudShadow`, `uCloudShadowCenter`, and `uCloudShadowExtent` to `ocean.js`.
- [ ] Multiply the ocean's direct sun and sun-glitter terms by sampled cloud transmittance.
- [ ] Decide separately how much the through-light/subsurface term should respond to the shadow map.
- [ ] Inject the shadow lookup into the knot's direct-light path or replace its material with a shader that can consume the map.
- [ ] Support the fallback grid if it remains part of the demo's diagnostic path.
- [ ] Keep screen-space god rays. They represent visible shafts, while the new map represents receiver illumination.

### Validation

- Shadows should move at the same world velocity as the cloud field.
- The shadow pattern must align plausibly with clouds along the sun direction.
- Camera motion should not make the pattern swim over the ocean.
- Direct sun glitter should dim under clouds while ambient sky reflection remains visible.
- The shadow should remain stable at the edge of the snapped map.
- `?cloud-shadows=0` must reproduce the unshadowed result.
- `?clouds=0` must produce a fully transmitting shadow map without unnecessary shadow-pass work.

### Main risks

- A top-down receiver map is suitable for the ocean but not a full 3D volumetric shadow representation.
- Shadow-map density work can become expensive if it uses too many samples or detailed erosion.
- Applying the map to every lighting term will make the ocean look dirty rather than shaded.

Keep the first implementation restricted to coarse transmittance and direct sunlight.

---

## Final integration and cleanup

- [ ] Make the six new paths the defaults one at a time, in dependency order.
- [ ] Retain useful diagnostics and remove temporary comparison code that duplicates entire shaders.
- [ ] Confirm resource disposal for 3D textures, cloud histories, and shadow targets.
- [ ] Confirm all targets resize correctly and histories reset after resize.
- [ ] Test these combinations:
  - default settings
  - `?clouds=0`
  - `?ocean=0`
  - `?taa=0`
  - `?cloud-res=0`
  - `?cloud-temporal=full`
  - `?cloud-temporal=interleaved`
  - `?cloud-noise=procedural`
  - `?cloud-ambient=legacy`
  - `?cloud-shadows=0`
  - `?rays=0`
  - `?rays=debug`
- [ ] Check horizon, upward, and fast-camera-motion views for each final combination.
- [ ] Verify `renderer.getContext().getError() === 0` after warmup and after resize.
- [ ] Run `node .fft-check.mjs` to catch unrelated ocean FFT regressions.
- [ ] Record real-GPU timings for cloud density, cloud temporal resolve, shadow generation, and total frame time if timer queries are available.
- [ ] Update comments in `clouds.js`, `taa.js`, `godrays.js`, and `ocean.js` so they describe the final data flow rather than the legacy path.

## Dependency order

```text
Dimensional profile
    -> split weather fields
        -> textured coarse and detailed density
            -> cloud-specific temporal reconstruction
            -> coarse-density ambient lighting
            -> world-space cloud shadows
```

Ambient lighting and world-space shadows may proceed in parallel after textured coarse density is stable. Temporal reconstruction should land before reducing ray count. Do not enable interleaved updates until full-update cloud history passes camera-motion and disocclusion tests.

## Completion criteria

The plan is complete when:

- coverage and type can vary independently;
- vertical profiles shape occupancy rather than only opacity;
- coarse and fine cloud density come from generated, tileable 3D textures by default;
- opaque clouds accumulate in a cloud-specific temporal history without trails;
- ambient variation responds to surrounding coarse density;
- the ocean and scene receive stable world-space cloud shadows;
- all legacy toggles and fallback paths remain usable until final cleanup;
- the default image preserves the light afternoon palette and pale-blue cloud interiors;
- the new default is no slower than the legacy default on the target real GPU, or any accepted cost is documented with its measured visual benefit.
