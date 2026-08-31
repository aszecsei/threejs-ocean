---
title: "Real-time volumetric cloud rendering — Nubis and Red Dead Redemption 2"
created: 2026-08-30
tags:
  - "real-time-rendering"
  - "volumetric-rendering"
  - "cloud-rendering"
  - "noise"
  - "graphics-programming"
  - "game-development"
related: []
---

# Real-time volumetric cloud rendering — Nubis and Red Dead Redemption 2

> [!note] Scope and provenance
> This is a source-traced investigation of the publicly available Guerrilla Games / Decima presentations on *Horizon Zero Dawn* (HZD), *Horizon Forbidden West* (HFW), and Fabian Bauer’s Rockstar presentation on *Red Dead Redemption 2* (RDR2). Formulas below are transcribed from the cited slides where possible. A few slide decks contain code as rasterized images; those cases are marked as such rather than silently reconstructed.

## The short answer

The central trick is not “find one beautiful noise.” It is to separate the cloud problem into a small number of controllable signals:

1. **A low-frequency occupancy or coverage field**: where clouds are allowed to exist in horizontal space.
2. **A vertical profile**: how density changes from cloud base to cloud top; this is the principal cloud-type control.
3. **A base-shape noise**: usually Perlin–Worley or a related low-frequency composite.
4. **An erosion/detail noise**: higher-frequency Worley-like structure subtracted from the base shape.
5. **A motion/distortion field**: wind plus curl/displacement noise.
6. **Lighting probabilities**: transmittance, anisotropic phase functions, cheap multiple-scattering approximations, and cloud-specific edge/interior terms.

That decomposition is the useful generalization. Cumulus, stratus, cumulonimbus, and cirrus are not fundamentally different renderers: they are different combinations of profiles, masks, coverage behavior, detail fields, and lighting parameters.

## 1. The physical baseline

For a participating medium with extinction coefficient $\sigma_{ext}(x)=\sigma_{abs}(x)+\sigma_{scat}(x)$, transmittance along a ray from $a$ to $b$ is

$$
T(a,b)=\exp\left(-\int_a^b \sigma_{ext}(x)\,dx\right).
$$

In a discretized ray march with samples $i$ and step length $\Delta s$:

$$
T \leftarrow T\,\exp(-\sigma_{ext,i}\Delta s).
$$

The single-scattering integral can be written schematically as

$$
L_o(a)=L_i(b)T(a,b)+\int_a^b T(a,x)\,\sigma_{scat}(x)\,P(\theta)\,L_i(x)\,dx.
$$

RDR2 presents this physical model explicitly: extinction is absorption plus scattering, transmittance is Beer–Lambert, and scattered light is integrated along the ray.[12] HFW’s 2022 deck attributes the exponential transmittance relation to Lambert and Beer, including Beer’s 1852 paper.[10]

The Henyey–Greenstein phase function used by Guerrilla is

$$
HG(g,\cos\theta)=\frac{1-g^2}{4\pi\left(1+g^2-2g\cos\theta\right)^{3/2}}.
$$

Here $g>0$ favors forward scattering, $g<0$ favors backward scattering, and $g=0$ is isotropic. The formula is normalized over the sphere; numerically, integrating it over solid angle gives approximately 1 for ordinary $g$ values. The underlying 1941 Henyey–Greenstein paper is listed in the HFW references.[10]

## 2. HZD 2015: the first production decomposition

### 2.1 Low clouds versus high clouds

HZD divided its spherical atmosphere into two practical rendering classes:

- low-altitude volumetric **strato-class** clouds, roughly 1,500–4,000 m;
- high-altitude **alto/cirro** clouds above roughly 4,000 m, represented as scrolling 2D textures rather than fully ray-marched volumes.[5]

The division is a budget decision, not a claim that cirrus is intrinsically two-dimensional. Thin upper-level clouds were cheap enough to represent with layered, scrolling textures; the thick lower layer received the volumetric treatment.[5]

### 2.2 The noise stack

The HZD base shape began with low-frequency noise. Plain fractal Brownian motion—multiple octaves of Perlin noise—gave detail but not the connected billows and cauliflower-like forms associated with cumulus. Guerrilla therefore combined Perlin and Worley noise into **Perlin–Worley** noise: Worley’s packed cellular/billowy structure is used to dilate or erode the connected Perlin field rather than replacing it.[5]

The 2015 representation was aggressively compressed:

- one 128³, four-channel 3D texture: a Perlin–Worley base plus three increasing-frequency Worley channels;
- one 32³, three-channel 3D texture: additional Worley detail;
- one 128², three-channel 2D curl-noise texture for turbulent distortion.[5]

A useful abstract notation is

$$
N_{PW}=R\bigl(N_P,1-N_W;0,1\bigr),
$$

where $R$ is a remap/inverse-lerp operation. The later Nubis deck gives the explicit form

$$
N_{PW}=\operatorname{remap}(N_P,1-N_W,1,0,1).
$$

The important point is that this is **not** ordinary multiplication of noise octaves. Remapping preserves a dense core better than repeatedly multiplying values in $[0,1]$.[1]

High-frequency noise is used as an **edge erosion**. In conceptual form:

$$
D=R(N_{detail},D_{threshold},1,0,1),
$$

or, in the later deck’s shorthand,

$$
D_{base}=\operatorname{remap}(N_{low},N_{high},1,0,1).
$$

The exact production code has more terms and saturations, but the shaping principle is stable: establish a coherent large body first, then carve detail out of its boundary.[1][5]

### 2.3 Vertical profiles are the cloud-type control

HZD used three mathematical low-cloud presets, blended at the sample position, instead of one generic height gradient.[5] The 2017 deck makes the mechanism explicit. Define

$$
\operatorname{remap}(v,a,b,c,d)=c+\frac{v-a}{b-a}(d-c).
$$

A stratus-like vertical band can be expressed as

$$
G_{stratus}(y)=
\operatorname{remap}(y,0.0,0.1,0.0,1.0)\;
\operatorname{remap}(y,0.2,0.3,1.0,0.0).
$$

Changing the two rising/falling intervals gives the other profiles. HZD’s presentation labels the principal presets **cumulus**, **stratocumulus**, and **stratus**.[5][1]

In normalized cloud height $y\in[0,1]$, the qualitative profiles are:

| Type | Profile intent | Resulting silhouette |
|---|---|---|
| Cumulus | Strong low-to-mid rise, rounded dense tops, rapidly thinning underside | Puffy “cauliflower” towers and billows |
| Stratocumulus | Broader/less vertically ambitious profile, still broken into cells | Connected rolls and lumpy sheets |
| Stratus | Narrow, broadly continuous vertical band | Flat or layered sheet |

The profile is a **probability envelope**, not a signed-distance surface. It says where density is likely; the noise and coverage fields decide whether a particular sample is actually occupied.

### 2.4 Weather maps and precipitation shaping

The HZD weather system supplied three spatial channels: red for coverage, green for precipitation, and blue for cloud type.[5] Precipitation transitions the weather toward cumulonimbus at high coverage; the presentation describes this transition at approximately 70% coverage.[5]

This is a useful pattern for cumulonimbus: do not try to make a storm solely by changing Worley frequencies. Use a weather control to alter several coupled properties at once:

- type/profile toward a taller cumulus-like body;
- coverage/density upward;
- precipitation and rain effects;
- increased absorption/darkening;
- wind and motion parameters.

HZD also used distance-conditioned art direction: clouds near the horizon were biased toward cumulus at higher coverage so the horizon would remain visually varied and rise above mountains.[5]

### 2.5 Ray marching and the first performance breakthrough

HZD marched through a spherical atmospheric layer. It used cheap, low-detail samples until a potential cloud surface was encountered, then stepped back and switched to expensive high-detail sampling. After consecutive empty samples it returned to the cheap march.[5]

The 2015 talk describes 64–128 potential view samples, six light samples in a cone toward the sun, and a distant cone sample for shadows from far clouds.[5] Temporal reprojection and a quarter-resolution update pattern—one of sixteen pixels per 4×4 block—reduced the cost by roughly an order of magnitude; the stated target was around 2 ms on PlayStation 4.[5]

The production lesson is as important as the numbers: **LOD the density function before you LOD the image**. Empty-space skipping, adaptive step sizes, and conditional light sampling save more than merely reducing every sample uniformly.

## 3. Nubis 2017: formalizing the art-directed system

The 2017 Nubis presentation recasts the cloud as two spatial controls:

- **coverage**: where a cloud formation exists;
- **type**: which vertical/profile behavior is used.[1]

The 3D density is then built from a profile, a coverage signal, and noise. A simplified conceptual model is

$$
D(x)=\operatorname{sat}\left(N_{base}(x)-\left[1-P(y,x)\right]\right),
$$

where $P(y,x)=G_{type}(y)C(x)$ is the dimensional profile and $N_{base}$ is the composite noise. The 2022 deck later gives this explicit form for its vertical-profile renderer:

$$
P=G_{vertical}(y)\,C(x),
$$

$$
D=\operatorname{sat}\left(N_{composite}-[1-P]\right).
$$

This “subtract the complement of the profile” formulation is the key shaping operation. When the profile/coverage signal rises, more of the noise survives; when it falls, the threshold becomes harder to pass.

### 3.1 Coverage erosion and inflation

Nubis applies coverage as an erosion/remap threshold rather than multiplying every noise sample by coverage:

$$
D_{coverage}=\operatorname{remap}(N, C,1,0,1).
$$

As $C$ increases, the apparent cloud expands and inflates. Keeping the broad coverage field stable while animating the detail noise makes clouds evolve without destroying the large-scale composition.[1]

### 3.2 Anvil shaping

For cumulonimbus-like tops, Nubis biases coverage near the top of the cloud. The 2017 deck gives:

$$
C' = C^{\,\operatorname{remap}\left(y,0.7,0.8,1.0,\operatorname{lerp}(1.0,0.5,A)\right)},
$$

where $A$ is an anvil-bias control.[1]

Because exponents below 1 increase values in $(0,1)$, this inflates the high-altitude coverage region and spreads the cloud laterally into an anvil. This is a particularly clean answer to “how do I shape a cumulonimbus?”: preserve the cumulus tower, then apply a height-localized exponent to its coverage field.

### 3.3 Cloud-map shaping

The Nubis cloud map represented about 100 km². Red and green carried coverage signals; several higher-frequency noises were composited over a lower-frequency air-mass-overlap field. Perlin was used for connected formations; Perlin–Worley produced more isolated island-like formations with connective tissue. Blue carried cloud type: 0=stratus, 0.5=stratocumulus, 1=cumulus.[1]

That is a powerful authoring abstraction:

$$
C(x)=R\bigl(N_{low}(x),N_{high}(x),\ldots\bigr),
$$

$$
T(x)=N_{type,low}(x),
$$

then profile selection is interpolated from $T$. Large-scale atmospheric organization lives in the low-frequency map; individual cloud identity lives in the local density function.

### 3.4 Nubis lighting

Nubis 2017 describes lighting as three probability-like factors: directional scattering, absorption/out-scattering with a multiple-scatter approximation, and in-scattering probability.[1]

The directional term uses the HG function. To obtain a controllable silver lining, Nubis combines a baseline lobe with a narrow forward lobe:

$$
E_{phase}=\max\left(
HG(\cos\theta,g),\;
I_{silver}\,HG(\cos\theta,0.99-S_{silver})
\right).
$$

The deck explicitly calls this an artistic/perceptual intervention rather than a fully physical phase model.[1]

For thick clouds, a second Beer–Lambert term pushes light deeper:

$$
E_{atten}=\max\left(
\exp(-d),\;0.7\exp(-0.25d)
\right).
$$

The first term gives normal attenuation; the second is a weaker, longer-reaching contribution. Nubis ramps its influence based on viewing/light direction.[1]

The improved in-scatter probability uses coarse/lodded neighborhood density and height. The slide text gives the structure

$$
P_{depth}=0.05+\operatorname{loddedDensity}^{\,R(y,0.3,0.85,0.5,2.0)},
$$

$$
P_{vertical}=R(y,0.07,0.14,0.1,1.0)^{0.8},
$$

$$
P_{inScatter}=P_{depth}P_{vertical}.
$$

The extracted slide text has a rasterization/parenthesis ambiguity in the first expression; the qualitative implementation is unambiguous: coarse surrounding density estimates available in-scatter, while a height gradient suppresses it near cloud bottoms.[1]

## 4. Nubis Evolved / HFW 2022

Guerrilla’s own summary says HFW extended Nubis beyond skybox clouds: clouds could be entered/fly-through environments and fast-spinning superstorms with internal flashes. The stated target was detailed 1080p rendering without temporal upscaling for these VFX cases.[6][8]

### 4.1 Vertical-profile model: a more explicit profile

The HFW 2022 deck defines

$$
q=\operatorname{remap}(h,h_{min},h_{max},0,1),
$$

$$
G_{bottom}=q^2,
$$

$$
G_{top}=(1-q)^{1.5},
$$

and an edge term that fades the envelope near its lateral boundary:

$$
G_{edge}=\operatorname{remap}(h_{sample},0,35,1,0).
$$

The dimensional profile is

$$
P=G_{bottom}G_{top}G_{edge}.
$$

The exponents are artistically meaningful: $q^2$ suppresses the base and makes the cloud build upward; $(1-q)^{1.5}$ softens the top; the edge term makes the finite envelope fade rather than terminate harshly.[10]

The deck then blends **wispy** and **billowy** noises by cloud type:

$$
N=\operatorname{lerp}(N_{wispy},N_{billowy},
R(h_f,T+0.1,T-0.1)).
$$

For lower type values, the result is wispy; for higher values, billowy. The slide labels examples around $T=0.25$, $0.5$, and $0.75$.[10]

Density is then shaped by

$$
D=h_f\left[\operatorname{sat}\left(N-[1-P]\right)\right]^{0.27}.
$$

A coarse density signal is separately generated for lighting and acceleration. This is a significant refinement over the earlier “one generic cloud volume” approach: the renderer carries both a detailed density and a cheaper envelope/coarse density.

### 4.2 Cirrus and 2.5-D shaping

For the thin upper layer, HFW uses a 2.5-D model with three authored noise profiles: **streaky**, **wispy**, and **round**. The cloud-type scalar selects between them:

$$
N=\operatorname{ValueRemap}\left(
T,0.5,1,
\operatorname{ValueRemap}(T,0,0.5,N_{streaky},N_{wispy}),
N_{round}
\right).
$$

Coverage then controls both contrast and occupancy:

$$
D=N^{\,1-\operatorname{ValueRemap}(C,0,1,-0.9,0.9)},
$$

$$
D\mathrel{\times}=\operatorname{ValueRemap}(C^3,0,0.5,0,1).
$$

This is the clearest public example of **noise shaping by cloud type** in the investigated material. Cirrus is not “just high-frequency noise”: it is a type-dependent interpolation among streaky, wispy, and round basis fields, with coverage changing the power curve and mask.[10]

### 4.3 Authoring NDFs

Nubis Evolved introduces authored **NDFs**—Nubis Data Fields—and influence NDFs. A procedural NDF can be combined with regional influence fields to make the same underlying cloud behaviors vary over geography and weather state. The deck shows separate regional results for cumulus, stratocumulus, and lighter cirrus conditions.[10]

This is the production answer to a common procedural-generation failure: a procedural system can be excellent at generating ugly repetition. The global procedural model supplies consistency; regional influence fields supply composition and place.

### 4.4 Supercells and cumulonimbus

HFW’s superstorm model separates the storm into recognizable parts: a mesocyclone/vortex, an anvil, a superstorm mask, vertical/cloud-type influences, and lighting controls.[10]

The mesocyclone is animated by rotating noise rings with different angular speeds and skew values. In simplified form:

$$
N_n(x,t)=N\left(R_{\omega_n t+s_n}(x-c)\right),
$$

where $c$ is the storm center, $\omega_n$ is ring rotation speed, and $s_n$ is ring skew.[10]

The spatial blend into the storm is

$$
M=\left[\operatorname{sat}\left(1-\frac{\lVert x-c\rVert}{r}\right)\right]^{0.1}.
$$

The low exponent makes the storm influence reach broadly across its radius. Normal cloud motion and storm rotation are blended through $M$.[10]

The anvil remains a distinct shaping component rather than a side effect of noise. The deck shows an anvil vertical gradient and a cirrus NDF around the superstorm center.[10]

### 4.5 HFW internal glow

The HFW deck uses a near-zero-cost internal glow approximation. Its potential energy term is

$$
E_{potential}=\left(1-\frac{d_1}{r}\right)^{12},
$$

multiplied by a height gradient and a fine-density suppression term:

$$
E_{glow}=E_{potential}\;\frac{d_2}{H}\;
\left(1-\operatorname{sat}(5D_{fine})\right).
$$

The high power makes the glow concentrate toward the storm core; fine density suppresses glow where the local cloud is too opaque.[10]

## 5. RDR2: unified volumetrics rather than a cloud-only renderer

RDR2’s presentation takes a broader systems approach. Clouds, global fog, localized fog, particles, lightning, sky scattering, terrain shadows, irradiance probes, and reflections share a material/lighting model where practical.[12]

### 5.1 Cloud placement and type

RDR2 uses a top-down cloud map covering approximately 32×32 km², stored as a 512×512 R16G16 texture. Weather and time-of-day parameters modulate mask/noise textures to produce density for two cloud layers.[12]

A cloud-height LUT then supplies altitude-dependent shape. The LUT contains profiles for cumulus and stratus-like behavior and is copied into a 1×128 RGBA8 texture slice selected by weather parameters.[12]

The cloud detail pass samples two 2D displacement fields at $xy$ and $xz$, producing a quasi-3D displacement, then combines that with a 3D Perlin/Worley sample and wind offset.[12] This is a striking memory/performance compromise: retain a volumetric-looking local result while avoiding a fully dense 3D detail representation everywhere.

The deck’s density shorthand is

$$
D=\operatorname{smoothstep}(S_{min}+L_{xy},S_{max}+L_{xy},C_{xy}),
$$

followed by detail erosion via an inverse lerp/rescale:

$$
D\leftarrow \operatorname{rescale}(N,D_{LUT,z},D).
$$

### 5.2 RDR2 phase function: two lobes plus a backscatter floor

RDR2 uses a phase function modeled around HG but composed from $M$ lobes with artist weights. The deck settles on $M=2$ and gives the structure

$$
P(g,\theta,\sigma_{ext})=
\left(w_0+\frac{w_1\sigma_{ext}}{M-1}\right)
\sum_{j=1}^{M}HG\left(\left(\frac{2}{3}\right)^j g,\theta\right).
$$

The exact slide typesetting is compact, but its intent is clear: successive lobes reduce anisotropy by a factor of $2/3$, broadening the scattering response. The artist weights and extinction dependence let the same framework serve cloud, smoke, and fog materials.[12]

RDR2 also fakes a plausible back-scattering floor by clamping the phase toward a Lambertian value:

$$
P' = \max\left(P,\frac{1}{\pi}\operatorname{rescale}(B_{min},B_{max},\sigma_{ext})\right).
$$

The authors explicitly call this an artistic/performance compromise, not a physically based derivation.[12]

### 5.3 Cheap multiple scattering

RDR2 uses two direct-light octaves to approximate multiple scattering, following Wrenninge’s observations.[12] This belongs beside Nubis’s second Beer term: both approaches spend a small, fixed amount of work to avoid the dead-black appearance of thick clouds.

A practical interpretation is

$$
L_{direct}\approx
T(d_0)P_0L_0+\alpha T(\beta d_0)P_1L_1,
$$

with $\beta<1$ and $\alpha<1$. The second term travels through a reduced optical depth and contributes a weaker, broader illumination component.

### 5.4 Near/far rendering split and reconstruction

RDR2 uses frustum-aligned voxel volumes for near-camera effects and ray marching for far-distance coverage.[12] The near volume is dynamic up to roughly 160 m and stores material, shadow, scattered-light, and extinction data. The far ray length is constrained by screen depth, ground-plane intersections, and the cloud dome.[12]

The ray step is refined when the base cloud shape is hit. Near clouds receive more samples; empty or distant regions receive fewer. The half-resolution far ray march casts one out of four rays and reconstructs the others temporally, with blue-noise offsets, neighborhood color bounds, and depth-aware rejection.[12]

### 5.5 Shadows and indirect light

RDR2 creates a cloud shadow map by ray marching cloud data from the directional-light view and storing transmittance-weighted depth in an exponential shadow map. The published format is 768×768 R16F with six mips, blurred to reduce aliasing and crawling.[12]

Ambient light comes from a low-resolution sky-scattering paraboloid for ray-marched regions and irradiance probes for frustum-volume regions. The sky probe map is 32×32 probes over 256×256 m² per probe, encoded as third-order spherical harmonics.[12]

This is the main conceptual difference from the early HZD presentation: RDR2 treats cloud lighting as part of a general atmospheric-light transport system, not as a cloud shader that happens to sample the sun.

## 6. A practical shaping recipe by cloud type

The public game presentations suggest this implementation-oriented taxonomy.

### Cumulus

- Coverage: broken but connected; Perlin or low-frequency Perlin-dominant map.
- Vertical profile: strong build-up from base to rounded top.
- Base noise: connected Perlin–Worley.
- Detail: high-frequency Worley erosion, especially at the edge.
- Bottom: increase wispy erosion or suppress density near the base.
- Lighting: forward HG lobe plus multiple-scatter lift; preserve bright internal billows.

### Stratocumulus

- Coverage: more continuous than cumulus, but retain cellular holes.
- Profile: lower, broader, less tower-like.
- Base noise: blend connected Perlin with Perlin–Worley.
- Detail: moderate billow scale; avoid excessive vertical growth.
- Lighting: less dramatic internal contrast than a storm tower.

### Stratus

- Coverage: broad and connected.
- Profile: narrow vertical band or slab.
- Base noise: low-amplitude modulation; high-frequency noise should not turn the layer into disconnected puffs.
- Detail: long horizontal variation, subtle erosion.
- Lighting: broad, relatively even response; do not overemphasize isolated silver linings.

### Cumulonimbus / supercell

- Start with a cumulus profile.
- Drive coverage upward with precipitation or storm state.
- Apply a top-localized anvil exponent, as in Nubis 2017.
- Add a separate mesocyclone mask and rotating rings, as in Nubis Evolved.
- Use a broad storm influence mask, internal glow, and lightning.
- Increase absorption/darkening and use stronger multi-scatter/ambient controls.

### Cirrus

- Use a 2D or 2.5-D layer when thickness permits.
- Select among streaky, wispy, and round bases by a type scalar, as in HFW 2022.
- Keep the layer high and thin; make motion mostly horizontal.
- Use low-frequency regional influence fields to avoid uniform global streaks.
- RDR2 places its cirrus layer around 8 km and uses a single 2D density lookup with the same general shading model.[12]

## 7. Unified pseudocode

```hlsl
float remap(float v, float a, float b, float c, float d)
{
    return c + ((v - a) / (b - a)) * (d - c);
}

float profile = SampleVerticalProfile(height, cloudType);
float coverage = SampleCloudMap(worldXY, weatherState);
float dimensional = profile * coverage;

// Cheap early-out / LOD test.
if (dimensional < densityThreshold)
    return 0.0;

float3 p = worldPosition + windDirection * timeOffset;
float baseNoise = SamplePerlinWorley(p);
float detailNoise = SampleWorleyDetail(p * detailFrequency);

// High-frequency noise erodes the boundary rather than multiplying the core away.
float density = saturate(baseNoise - (1.0 - dimensional));
density = remap(detailNoise, detailThreshold, 1.0, 0.0, density);

// Type-specific additions.
if (cloudTypeIsStorm)
{
    float anvilExponent = remap(height, 0.7, 0.8, 1.0,
                                 lerp(1.0, 0.5, anvilBias));
    coverage = pow(coverage, anvilExponent);
    density = ApplySuperstormMaskAndRotatingRings(density, worldPosition, time);
}

float transmittance = exp(-summedDensityToLight);
float phase = max(HG(cosTheta, g),
                  silverIntensity * HG(cosTheta, silverG));
float multipleScatter = max(exp(-d), 0.7 * exp(-0.25 * d));
float light = transmittance * phase * multipleScatter;
```

This is deliberately a synthesis, not a claim that it is Guerrilla’s or Rockstar’s literal source code. The cited decks provide the individual production operations; the composition above makes their shared structure explicit.

## 8. What these systems teach

1. **Shape with fields, not with a noise preset.** A noise function has no cloud identity until a vertical profile, coverage field, and detail policy give it one.
2. **Use remapping as a density-preserving operation.** Multiplication of many $[0,1]$ signals collapses density. Threshold/remap/erosion preserves a readable dense core.[1]
3. **Keep macro structure stable while animating microstructure.** Nubis explicitly keeps coverage static while animating noise and wind detail.[1]
4. **Make cloud type a continuous parameter.** HZD interpolates among cumulus/stratocumulus/stratus; HFW interpolates among streaky/wispy/round; this makes weather transitions smooth rather than state-machine pops.[1][10]
5. **Cumulonimbus is a coupled phenomenon.** Anvil, precipitation, storm rotation, darkening, lightning, and internal glow should be coordinated by a weather/VFX state, not independently randomized.[5][10]
6. **Use coarse density for decisions and detailed density for appearance.** Both Guerrilla and Rockstar use LODs, coarse fields, early exits, and conditional expensive work.[1][5][10][12]
7. **The final image is temporal.** Reprojection, blue noise, checkerboard/ray sparsity, and neighborhood validation are part of the renderer, not post-hoc polish.[5][10][12]

## Adjacent topic

The adjacent topic this investigation brushes against is **cloud representation under camera penetration**: the point at which a 2.5-D skybox must become a true voxel or implicit volume. Guerrilla’s later *Nubis³* account says it moved to voxel-based clouds, compressed signed-distance-field ray-march acceleration, fluid-simulation-based modeling, voxel up-rezing, and new dark-edge/inner-glow methods.[7] That is the natural next chapter after the HZD/HFW 2.5-D work.

## What was not findable

- The 2015 powder-sugar function’s exact code was not recoverable as text from the public deck; the relevant slide is image-based. The 2015 presentation describes the effect and its view dependence, while the 2017 deck documents the improved in-scatter probability formulation.[5][1]
- I did not find a public, complete HFW production source dump or a publicly documented numeric table of every artist-tuned profile/noise parameter. The decks expose representative formulas and architecture, not the entire Decima implementation.[6][10]
- The RDR2 material is a combined SIGGRAPH slide deck with speaker notes, not a separately published Bauer PDF in the retrieved course materials. The claims above are therefore traced to the combined course deck.[12]

## Sources

[1] https://advances.realtimerendering.com/s2017/Nubis%20-%20Authoring%20Realtime%20Volumetric%20Cloudscapes%20with%20the%20Decima%20Engine%20-%20Final%20.pdf — Schneider et al., Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine (SIGGRAPH 2017 ARTR)

[5] https://advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf — Schneider, Real-Time Volumetric Cloudscapes of Horizon Zero Dawn (SIGGRAPH 2015 ARTR)

[6] https://www.guerrilla-games.com/read/nubis-evolved — Guerrilla Games, “Nubis, Evolved” (2022)

[7] https://www.guerrilla-games.com/read/nubis-cubed — Guerrilla Games, “Nubis³” (2023)

[8] https://gdcvault.com/play/1028023/The-Real-Time-Volumetric-Superstorms — Andrew Schneider, “The Real-Time Volumetric Superstorms of Horizon Forbidden West” (GDC 2022)

[10] https://advances.realtimerendering.com/s2022/SIGGRAPH2022-Advances-NubisEvolved-NoVideos.pdf — Schneider, Nubis Evolved: Real-Time Volumetric Clouds for Skies, Environments, and VFX (SIGGRAPH 2022 ARTR)

[12] https://advances.realtimerendering.com/s2019/slides_public_release.pptx — Fabian Bauer, Creating the Atmospheric World of Red Dead Redemption 2: A Complete and Integrated Solution (SIGGRAPH 2019 ARTR combined slides)
