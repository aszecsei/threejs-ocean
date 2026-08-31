import * as THREE from "three";
import { GPUComputationRenderer, type Variable } from "three/addons/misc/GPUComputationRenderer.js";
import SPECTRUM_FRAG from "./shaders/spectrum.frag.glsl";
import { buildButterflyTable } from "./butterfly.js";
import { band, drain } from "../../loading/scheduler.js";
import type { Bake } from "../../loading/types.js";

// --- Ocean FFT pipeline -----------------------------------------------------
// GPU Tessendorf simulation:
//   JONSWAP spectrum (CPU init) -> time-evolved spectrum -> 2D inverse FFT
//   (Cooley-Tukey DIT, bit-reversed input, precomputed butterfly table,
//   2*log2(N) ping-pong passes per chain) -> displacement + Jacobian ->
//   foam accumulation with exponential decay.
//
// Two complex signals are packed per RGBA texture and transformed together:
//   chain A: RG = height h,     BA = choppy-x Dx
//   chain B: RG = choppy-z Dz
//   chain C: RG = slope dh/dx,  BA = slope dh/dz
// So the full sim is 3 chains * 2*log2(N) butterfly passes + 3 spectrum +
// combine + foam. For N=256 that's 53 fullscreen passes.
//
// Slopes come out of chain C analytically (multiply by ik in Fourier space)
// rather than from central differences on the height texel grid. Finite
// differences attenuate slope by ~sinc(k*dx), which blunts exactly the
// high-k slopes that make crests read sharp; the FFT already has the exact
// derivative for the cost of one more packed chain.
//
// Conventions:
//   - Wavenumber index wraps: n <= N/2 -> n, else n - N (avoids the
//     (-1)^(i+j) checkerboard of the n - N/2 convention).
//   - The spectrum pass writes into BIT-REVERSED texel positions (per axis),
//     so the DIT butterflies read in bit-reversed order and emit natural
//     order — no separate reversal pass.
//   - GPUComputationRenderer injects `uniform sampler2D <depVarName>` for
//     each dependency and a `resolution` define; don't redeclare those here.

/**
 * One directional wave spectrum after {@link resolveSpectra}: the authored
 * knobs plus the two JONSWAP quantities derived from them.
 */
interface SpectrumParams {
  scale: number;
  fetch: number;
  windSpeed: number;
  angle: number;
  gamma: number;
  spreadBlend: number;
  swell: number;
  fade: number;
  /** JONSWAP alpha; filled in by resolveSpectra. */
  alpha: number;
  /** Peak angular frequency; filled in by resolveSpectra. */
  peakOmega: number;
}

export const OCEAN_FFT_DEFAULTS = {
  size: 256,             // FFT resolution N (power of two)
  patchSize: 200,        // L: world-space period of the wave field
  windDir: new THREE.Vector2(1, 0.35).normalize(),
  heightRms: 0.85,       // target RMS wave height in world units

  // --- Wind sea (JONSWAP + TMA + cosine-2s spreading) --------------------
  // These are the sea-state knobs. "Choppier", "longer swell" and
  // "more cross-sea" are all reachable from here without re-tuning
  // heightRms, which stays an exact RMS wave height whatever they say.
  windSpeed: 13,         // m/s; sets JONSWAP alpha and the peak frequency
  fetch: 200000,         // m of open water the wind has blown across.
                         // Longer fetch = a lower peak = longer, smoother
                         // swell. 200 km reproduces the Phillips look this
                         // replaced (mean wavelength 91 m vs 100 m, RMS
                         // slope 0.144 vs 0.151); much past ~600 km the peak
                         // falls outside a 200 m patch and stops rendering.
  depth: 200,            // m; feeds the TMA correction and the dispersion
                         // relation. 500 m is deep water (no visible effect);
                         // drop toward ~15 m for shallow-water behaviour.
  peakEnhancement: 6.3,  // JONSWAP gamma: peakiness of the wind sea
  spreadBlend: 1.0,      // 0 = broad cos^2 spreading, 1 = full cosine-2s
  swell: 0.25,           // 0..1; tightens direction the way long-travelled
                         // swell does (not the second spectrum below)
  smallWaveCutoff: 0.55, // shortWavesFade l in exp(-k^2 l^2): suppresses
                         // ripple this cascade cannot resolve. A banded
                         // cascade sets its own.

  // --- Second superposed spectrum (a swell from another heading) --------
  // Unity's Spectrums[1]. scale 0 disables it, which is the default: the
  // scene's look is a single wind sea. Turn it up for a cross-sea.
  swellSpectrum: {
    scale: 0,          // 0 disables; ~0.3 gives a clear second wave train
    windSpeed: 6,
    fetch: 500000,       // long fetch: swell is old, long and clean
    angleOffsetDeg: 55,  // heading relative to windDir
    peakEnhancement: 3.3,// swell is not peak-enhanced
    spreadBlend: 0.2,    // narrow: swell arrives from one direction
    swell: 1.0,
    smallWaveCutoff: 1.5,
  },
  // Wavenumber band this cascade owns, rad/m. A single cascade takes
  // everything; with two, the boundary must be shared so the overlapping
  // wavenumbers are not synthesized twice (that reads as double roughness).
  cutoffLow: 0,
  cutoffHigh: Infinity,
  // Shared amplitude scale across cascades (see cascadeAmpScale). Null means
  // "normalize this cascade alone to heightRms".
  ampScale: null as number | null,
  choppy: 4.5,           // horizontal (Gerstner) displacement scale (crest sharpness)
  foamThreshold: 0.2,  // Jacobian below this starts injecting foam
  foamSpan: 0.5,         // J falloff width below the threshold
  foamGain: 3.0,         // max inject rate per frame at J << threshold
  foamDecay: 0.8,        // per-second exponential decay rate (slower = longer fade)
};

const SEED = 1337;

// Anisotropic filtering on the mesh-facing FFT targets (clamped to the GPU's
// max). Matches the aniso 6 the reference Unity implementation uses.
const ANISOTROPY = 6;

// Deterministic RNG (mulberry32) so the sea looks the same across reloads.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const G = 9.81;

/** The fully-resolved option set: every key of OCEAN_FFT_DEFAULTS present. */
export type ResolvedFftOptions = typeof OCEAN_FFT_DEFAULTS;

/** Caller-supplied overrides. swellSpectrum merges field-wise, not wholesale. */
export type OceanFftOptions =
  Partial<Omit<ResolvedFftOptions, "swellSpectrum">> & {
    swellSpectrum?: Partial<ResolvedFftOptions["swellSpectrum"]>;
  };

// Options merge that reaches into swellSpectrum, so a caller can override one
// swell field without silently dropping the rest of the block.
function mergeOpts(c: OceanFftOptions): ResolvedFftOptions {
  return {
    ...OCEAN_FFT_DEFAULTS,
    ...c,
    swellSpectrum: { ...OCEAN_FFT_DEFAULTS.swellSpectrum, ...(c.swellSpectrum ?? {}) },
  };
}

// --- Wave spectrum (JONSWAP + TMA + Donelan-Banner spreading) ---------------
// Ported from gasgiant/FFT-Ocean's InitialSpectrum.compute, which follows
// Horvath 2015. Replaces the textbook Phillips spectrum: same k^-4 tail, but
// the peak is placed by fetch and wind speed instead of being wherever
// exp(-1/(k L)^2) happened to put it, and the directional spread narrows with
// frequency the way a real sea does.
//
// Dispersion is sqrt(g k tanh(k d)), not the deep-water sqrt(g k). This must
// match SPECTRUM_SHADER's copy exactly — same clamp, same form — or the
// amplitudes and the time evolution describe different waves. (Same JS-mirror
// discipline sky.js follows for SKY_CONSTS.)
const dispersion = (k: number, depth: number) => Math.sqrt(G * k * Math.tanh(Math.min(k * depth, 20)));

// |domega/dk|, which folds the k-space cell into the amplitude. Without it a
// spectral density in omega is being read as one in k and the balance between
// long and short waves is wrong.
function dispersionDerivative(k: number, depth: number): number {
  const kd = Math.min(k * depth, 20);
  const th = Math.tanh(kd);
  const ch = Math.cosh(kd);
  return (G * ((depth * k) / (ch * ch) + th)) / dispersion(k, depth) / 2;
}

function tmaCorrection(omega: number, depth: number): number {
  const oh = omega * Math.sqrt(depth / G);
  if (oh <= 1) return 0.5 * oh * oh;
  if (oh < 2) return 1 - 0.5 * (2 - oh) * (2 - oh);
  return 1;
}

function jonswap(omega: number, depth: number, p: SpectrumParams): number {
  const sigma = omega <= p.peakOmega ? 0.07 : 0.09;
  const d = omega - p.peakOmega;
  const r = Math.exp(-(d * d) / (2 * sigma * sigma * p.peakOmega * p.peakOmega));
  return (
    p.scale * tmaCorrection(omega, depth) * p.alpha * G * G *
    Math.pow(omega, -5) *
    Math.exp(-1.25 * Math.pow(p.peakOmega / omega, 4)) *
    Math.pow(p.gamma, r)
  );
}

// Cosine-2s spreading. The polynomial is the usual fit to the normalisation
// integral, which has no closed form.
function normalisationFactor(s: number): number {
  const s2 = s * s, s3 = s2 * s, s4 = s3 * s;
  return s < 5
    ? -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163
    : -4.8e-8 * s4 + 1.07e-5 * s3 - 9.53e-4 * s2 + 5.9e-2 * s + 3.93e-1;
}

function directionSpectrum(theta: number, omega: number, p: SpectrumParams): number {
  // Donelan-Banner: the spread narrows away from the peak, and `swell` adds
  // the extra tightening a long-travelled train has.
  const sp = omega > p.peakOmega
    ? 9.77 * Math.pow(omega / p.peakOmega, -2.5)
    : 6.97 * Math.pow(omega / p.peakOmega, 5);
  const sw = Math.tanh(Math.min(omega / p.peakOmega, 20));
  const sExp = sp + 16 * sw * p.swell * p.swell;
  const dt = theta - p.angle;
  const c2s = normalisationFactor(sExp) * Math.pow(Math.abs(Math.cos(0.5 * dt)), 2 * sExp);
  const cos2 = (2 / Math.PI) * Math.cos(dt) * Math.cos(dt);
  return cos2 + (c2s - cos2) * p.spreadBlend;
}

// Resolve a cascade's options into JONSWAP parameter blocks (wind sea, plus
// the swell when its scale is non-zero). alpha and peakOmega depend only on
// fetch and wind speed, so they are derived once here, not per texel.
/** Fills in the two JONSWAP quantities implied by fetch and wind speed. */
function withJonswapDerived(p: Omit<SpectrumParams, "alpha" | "peakOmega">): SpectrumParams {
  return {
    ...p,
    alpha: 0.076 * Math.pow((G * p.fetch) / (p.windSpeed * p.windSpeed), -0.22),
    peakOmega: 22 * Math.pow((p.windSpeed * p.fetch) / (G * G), -0.33),
  };
}

function resolveSpectra(o: ResolvedFftOptions): SpectrumParams[] {
  const windAngle = Math.atan2(o.windDir.y, o.windDir.x);
  const out = [{
    scale: 1,
    fetch: o.fetch,
    windSpeed: o.windSpeed,
    angle: windAngle,
    gamma: o.peakEnhancement,
    spreadBlend: o.spreadBlend,
    swell: o.swell,
    fade: o.smallWaveCutoff,
  }];
  const sw = o.swellSpectrum;
  if (sw && sw.scale > 0) {
    out.push({
      scale: sw.scale,
      fetch: sw.fetch,
      windSpeed: sw.windSpeed,
      angle: windAngle + (sw.angleOffsetDeg * Math.PI) / 180,
      gamma: sw.peakEnhancement,
      spreadBlend: sw.spreadBlend,
      swell: sw.swell,
      // The cascade's own cutoff still applies: a spectrum must not ask for
      // waves finer than the cascade can carry.
      fade: Math.max(sw.smallWaveCutoff, o.smallWaveCutoff),
    });
  }
  return out.map(withJonswapDerived);
}

// Per-mode height variance at unit amplitude scale, zero outside the
// cascade's wavenumber band. This is the `2 S |domega/dk| / k` of the
// reference implementation; multiplying by dk^2 gives the mode's variance,
// which is exactly what the old Phillips `P` was being used as. Shared by
// buildH0Texture and spectrumVariance so the two can never disagree about
// what a cascade contains.
function waveSpectrum(kx: number, kz: number, depth: number, specs: SpectrumParams[], kLow: number, kHigh: number): number {
  const k = Math.hypot(kx, kz);
  if (k <= 1e-6 || k < kLow || k >= kHigh) return 0;
  const omega = dispersion(k, depth);
  if (!(omega > 0)) return 0;
  const theta = Math.atan2(kz, kx);
  let s = 0;
  for (const p of specs) {
    s += jonswap(omega, depth, p) *
      directionSpectrum(theta, omega, p) *
      Math.exp(-p.fade * p.fade * k * k);
  }
  const v = (2 * s * Math.abs(dispersionDerivative(k, depth))) / k;
  return isFinite(v) && v > 0 ? v : 0;
}

// Height variance this cascade would carry at unit amplitude scale.
// Weighted by the cell area dk^2 = (2*pi/L)^2, which is what makes the
// numbers comparable across cascades of different patch size: P is a
// spectral *density*, so a mode's variance is P * dk^2, not P.
export function* bakeSpectrumVariance(c: OceanFftOptions, label = "Wave spectrum"): Bake<number> {
  const o = mergeOpts(c);
  const N = o.size;
  const specs = resolveSpectra(o);
  const dk = (2 * Math.PI) / o.patchSize;
  let v = 0;
  for (let jm = 0; jm < N; jm++) {
    for (let jn = 0; jn < N; jn++) {
      const sn = jn <= N / 2 ? jn : jn - N;
      const sm = jm <= N / 2 ? jm : jm - N;
      v += waveSpectrum(sn * dk, sm * dk, o.depth, specs, o.cutoffLow, o.cutoffHigh);
    }
    yield { label, detail: `variance ${jm + 1}/${N}`, fraction: (jm + 1) / N };
  }
  return v * dk * dk;
}

export function spectrumVariance(c: OceanFftOptions): number {
  return drain(bakeSpectrumVariance(c));
}

// Amplitude scale that makes a *set* of cascades add up to heightRms of RMS
// wave height. Their variances sum, so normalizing each one on its own would
// make the sea grow every time a cascade is added.
export function* bakeCascadeAmpScale(
  cascades: OceanFftOptions[],
  heightRms: number,
  label = "Wave spectrum"
): Bake<number> {
  let v = 0;
  for (let i = 0; i < cascades.length; i++) {
    v += yield* band(
      bakeSpectrumVariance(cascades[i], label),
      label,
      i / cascades.length,
      (i + 1) / cascades.length,
      // Cascades have different sizes, so an unprefixed row count would appear
      // to run backwards at the seam.
      cascades.length > 1 ? `cascade ${i + 1}/${cascades.length}` : undefined
    );
  }
  return v > 0 ? heightRms / Math.sqrt(v) : 0;
}

export function cascadeAmpScale(cascades: OceanFftOptions[], heightRms: number): number {
  return drain(bakeCascadeAmpScale(cascades, heightRms));
}

// --- h0 spectrum texture ----------------------------------------------------
// RG = h0(k) = gaussian * sqrt(P(k)); BA = conj(h0(-k)) (mirrored texel).
// Amplitudes carry the shared ampScale, so expected RMS wave height across
// all cascades == heightRms world units — makes the height knob physical
// and independent of both `size` and the cascade count.
function* bakeH0Texture(o: ResolvedFftOptions, ampScale: number, label: string): Bake<THREE.DataTexture> {
  const N = o.size;
  const L = o.patchSize;
  const specs = resolveSpectra(o);
  const rng = makeRng(SEED);
  const gauss = () => {
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };

  const dk = (2 * Math.PI) / L;
  const amps = new Float32Array(N * N);

  for (let jm = 0; jm < N; jm++) {
    for (let jn = 0; jn < N; jn++) {
      const sn = jn <= N / 2 ? jn : jn - N;
      const sm = jm <= N / 2 ? jm : jm - N;
      amps[jm * N + jn] = waveSpectrum(sn * dk, sm * dk, o.depth, specs, o.cutoffLow, o.cutoffHigh);
    }
    yield { label, detail: `h0 row ${jm + 1}/${N}`, fraction: (jm + 1) / N };
  }

  // Per-texel amplitude. Two unit gaussians (re, im) give E|h0|^2 = 2 a^2,
  // and h(k,t) = h0 e^{iwt} + h0*(-k) e^{-iwt} doubles that again, so the
  // real-valued IFFT has variance sum(4 a^2). With a = sqrt(P) * dk * s / 2
  // that sum is s^2 * sum(P * dk^2) — the same quantity spectrumVariance
  // adds up, which is why the shared scale makes the cascades compose.
  const data = new Float32Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const a = 0.5 * Math.sqrt(amps[i]) * dk * ampScale;
    data[i * 4 + 0] = gauss() * a; // h0(k) real
    data[i * 4 + 1] = gauss() * a; // h0(k) imag
  }
  // BA[j] = conj(RG[mirror(j)]) so h0*(-k) is exact for every texel.
  for (let jm = 0; jm < N; jm++) {
    for (let jn = 0; jn < N; jn++) {
      const src = (((N - jm) % N) * N + ((N - jn) % N)) * 4;
      const dst = (jm * N + jn) * 4;
      data[dst + 2] = data[src];
      data[dst + 3] = -data[src + 1];
    }
  }

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// --- Butterfly table --------------------------------------------------------
// N x log2(N) float RGBA. Row s = FFT stage. Per output index j:
//   r < m : out = in[j]   + w * in[j+m],  w = +exp(+2i*pi*r/2^s)
//   r >= m: out = in[j-m] - w * in[j],    w = -exp(+2i*pi*(r-m)/2^s)
// (the +/- sign folds into the stored twiddle; DIT with bit-reversed input).
function buildButterflyTexture(N: number): THREE.DataTexture {
  const stages = Math.round(Math.log2(N));
  const tex = new THREE.DataTexture(
    buildButterflyTable(N), N, stages, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// --- Shaders ----------------------------------------------------------------

// Time evolution. Writes the spectrum at BIT-REVERSED positions (both axes)
// so the subsequent DIT butterflies emit natural order directly.
const SPECTRUM_SHADER = SPECTRUM_FRAG;

// One radix-2 butterfly stage. Reads the precomputed butterfly table
// (index pair + twiddle with sign folded in) and combines two input texels.
function fftShader(depName: string): string {
  return /* glsl */ `
    uniform sampler2D uButterfly;
    uniform float uSize;
    uniform float uStages;
    uniform float uStage;
    uniform float uHorizontal;

    vec2 cmul(vec2 a, vec2 b) {
      return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / resolution.xy;
      vec2 p = floor(gl_FragCoord.xy);

      float j = mix(p.y, p.x, uHorizontal);
      vec4 bw = texture2D(uButterfly, vec2((j + 0.5) / uSize, (uStage + 0.5) / uStages));
      float ia = bw.x;
      float ib = bw.y;
      vec2 w = bw.zw;

      vec2 uvA, uvB;
      if (uHorizontal > 0.5) {
        uvA = vec2((ia + 0.5) / uSize, uv.y);
        uvB = vec2((ib + 0.5) / uSize, uv.y);
      } else {
        uvA = vec2(uv.x, (ia + 0.5) / uSize);
        uvB = vec2(uv.x, (ib + 0.5) / uSize);
      }
      vec4 va = texture2D(${depName}, uvA);
      vec4 vb = texture2D(${depName}, uvB);
      gl_FragColor = va + vec4(cmul(vb.xy, w), cmul(vb.zw, w));
    }
  `;
}

// Packs the transformed spectra into (dx, h, dz, J): Gerstner choppy
// displacement, height, and the Jacobian of the horizontal displacement map
// (J < 0 marks pinched crests -> foam). The Jacobian cross terms stay on
// central differences — they differentiate the *choppy* fields, which have
// no dedicated spectrum chain; only the height slope went analytic.
function combineShader(nameA: string, nameB: string): string {
  return /* glsl */ `
  uniform float uSize;
  uniform float uPatchSize;
  uniform float uChoppy;

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec2 e = vec2(1.0 / uSize, 0.0);
    float slope = 0.5 * uSize / uPatchSize;

    vec4 A   = texture2D(${nameA}, uv);
    vec4 Axp = texture2D(${nameA}, uv + e);
    vec4 Axm = texture2D(${nameA}, uv - e);
    vec4 Azp = texture2D(${nameA}, uv + e.yx);
    vec4 Azm = texture2D(${nameA}, uv - e.yx);
    vec4 B   = texture2D(${nameB}, uv);
    vec4 Bxp = texture2D(${nameB}, uv + e);
    vec4 Bxm = texture2D(${nameB}, uv - e);
    vec4 Bzp = texture2D(${nameB}, uv + e.yx);
    vec4 Bzm = texture2D(${nameB}, uv - e.yx);

    float dx = A.z * uChoppy;
    float h  = A.x;
    float dz = B.x * uChoppy;

    float dxx = (Axp.z - Axm.z) * slope * uChoppy;
    float dxz = (Azp.z - Azm.z) * slope * uChoppy;
    float dzx = (Bxp.x - Bxm.x) * slope * uChoppy;
    float dzz = (Bzp.x - Bzm.x) * slope * uChoppy;

    float J = (1.0 + dxx) * (1.0 + dzz) - dxz * dzx;
    gl_FragColor = vec4(dx, h, dz, J);
  }
  `;
}

// Foam accumulation ping-pong: injects where the Jacobian dips below the
// threshold, decays exponentially -> foam fades in on pinched crests and
// fades out over ~1/foamDecay seconds. Also packs the water normal into yzw
// (built from chain C, the analytic slope pair) so the mesh shader gets a
// filtered normal for free — the texture layout the mesh sees is unchanged.
function foamShader(nameC: string): string {
  return /* glsl */ `
  uniform float uDeltaT;
  uniform float uFoamDecay;
  uniform float uFoamThreshold;
  uniform float uFoamSpan;
  uniform float uFoamGain;

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;

    vec4 C = texture2D(textureCombine, uv);
    // Analytic slopes: chain C is the IFFT of ik*h~, so .x is dh/dx and .z
    // is dh/dz directly in world units (k already carries the 2*pi/L).
    vec4 S = texture2D(${nameC}, uv);
    vec3 nrm = normalize(vec3(-S.x, 1.0, -S.z));

    float prev = texture2D(textureFoam, uv).x;
    float J = C.w;
    // Full injection at J <= threshold - span, none at J >= threshold.
    // Written with ascending edges: smoothstep(edge0 > edge1) is undefined
    // in GLSL and returned 1 here on the flat start-up surface (J == 1),
    // which flooded the whole sea with foam for the first few seconds.
    float inject = (1.0 - smoothstep(uFoamThreshold - uFoamSpan, uFoamThreshold, J)) * uFoamGain;
    float foam = max(prev * exp(-uDeltaT * uFoamDecay), inject);
    gl_FragColor = vec4(clamp(foam, 0.0, 1.0), nrm);
  }
  `;
}

// --- Pipeline factory -------------------------------------------------------
// Returns { update(dt, t), displacementTexture(), foamTexture(), params }.
export function* buildOceanFft(
  renderer: THREE.WebGLRenderer,
  opts: OceanFftOptions = {},
  label = "Wave cascade"
) {
  const o = mergeOpts(opts);
  const N = o.size;
  const stages = Math.round(Math.log2(N));
  if (1 << stages !== N) throw new Error(`FFT size must be a power of two (got ${N})`);

  const gpu = new GPUComputationRenderer(N, N, renderer);
  gpu.setDataType(THREE.FloatType);

  const ampScale = o.ampScale ?? (yield* band(bakeCascadeAmpScale([o], o.heightRms, label), label, 0, 0.3));
  const h0Tex = yield* band(bakeH0Texture(o, ampScale, label), label, 0.3, 0.9);
  const butterflyTex = buildButterflyTexture(N);
  const dummy = gpu.createTexture();
  // Seed for the combine stage: a flat surface has Jacobian 1, not 0.
  // GPUComputationRenderer feeds each variable its dependencies' previous
  // outputs, so for the first ~2*stages frames the foam pass reads this seed
  // (and then a still-flat surface); a zero Jacobian there injects full foam
  // over the whole sea that then takes seconds to decay.
  const flatSeed = gpu.createTexture();
  {
    const px = flatSeed.image.data as Float32Array;
    for (let i = 3; i < px.length; i += 4) px[i] = 1.0;
  }

  // Add in compute order (GPUComputationRenderer executes in add order).
  const specA = gpu.addVariable("textureSpecA", SPECTRUM_SHADER, dummy);
  const specB = gpu.addVariable("textureSpecB", SPECTRUM_SHADER, dummy);
  const specC = gpu.addVariable("textureSpecC", SPECTRUM_SHADER, dummy);
  specB.material.defines.CHAIN_B = "";
  specC.material.defines.CHAIN_C = "";
  for (const v of [specA, specB, specC]) {
    Object.assign(v.material.uniforms, {
      uH0: { value: h0Tex },
      uTime: { value: 0 },
      uSize: { value: N },
      uBits: { value: stages },
      uPatchSize: { value: o.patchSize },
      uDepth: { value: o.depth },
    });
  }

  type Chain = "A" | "B" | "C";
  const fftEnd = {} as Record<Chain, Variable>;
  const specOf: Record<Chain, Variable> = { A: specA, B: specB, C: specC };
  for (const chain of ["A", "B", "C"] as const) {
    let prev = specOf[chain];
    for (let p = 0; p < 2 * stages; p++) {
      const depName = p === 0 ? `textureSpec${chain}` : `textureFft${chain}${p - 1}`;
      const v = gpu.addVariable(`textureFft${chain}${p}`, fftShader(depName), dummy);
      gpu.setVariableDependencies(v, [prev]);
      Object.assign(v.material.uniforms, {
        uButterfly: { value: butterflyTex },
        uSize: { value: N },
        uStages: { value: stages },
        uStage: { value: p % stages },
        uHorizontal: { value: p < stages ? 1 : 0 },
      });
      prev = v;
    }
    fftEnd[chain] = prev;
  }

  const combine = gpu.addVariable(
    "textureCombine",
    combineShader(fftEnd.A.name, fftEnd.B.name),
    flatSeed
  );
  gpu.setVariableDependencies(combine, [fftEnd.A, fftEnd.B]);
  Object.assign(combine.material.uniforms, {
    uSize: { value: N },
    uPatchSize: { value: o.patchSize },
    uChoppy: { value: o.choppy },
  });

  // Foam reads the slope chain directly rather than through combine. That
  // makes the normal one frame newer than the height it belongs to (combine
  // is itself one pass downstream of the chains) — ~1/60 s of wave motion
  // against a 0.8 m texel, far below the finite-difference error it replaces.
  const foam = gpu.addVariable("textureFoam", foamShader(fftEnd.C.name), dummy);
  gpu.setVariableDependencies(foam, [combine, foam, fftEnd.C]);
  Object.assign(foam.material.uniforms, {
    uDeltaT: { value: 0.016 },
    uFoamDecay: { value: o.foamDecay },
    uFoamThreshold: { value: o.foamThreshold },
    uFoamSpan: { value: o.foamSpan },
    uFoamGain: { value: o.foamGain },
  });

  // Mesh-facing textures want bilinear + wrap; compute passes read exact
  // texel centers so filtering is cosmetic there. Repeat wrap also makes the
  // finite-difference neighbor taps wrap at patch borders.
  //
  // These MUST be set on the variables before init(): init() creates the
  // render targets from these fields and renders into them right away, which
  // bakes the sampler state. Three.js never re-applies wrap/filter changes
  // made on a render-target texture afterwards, so a post-init assignment on
  // rt.texture silently leaves the textures clamp-to-edge + nearest (the
  // wave field then stops outside world [0, patchSize]^2 and looks blocky).
  //
  // Mipmaps: without them the FFT normal aliases badly at distance (the
  // vertex-shader height/choppy distance fades and sampleFoamCubic were both
  // partly standing in for filtering the hardware should do). minFilter rides
  // through createRenderTarget, but generateMipmaps and anisotropy do not —
  // they live on the render target's texture, which does not exist until
  // init(). Hence the wrapper below: it runs inside init(), before the first
  // renderTexture() bakes the sampler state.
  for (const v of [combine, foam]) {
    v.wrapS = THREE.RepeatWrapping;
    v.wrapT = THREE.RepeatWrapping;
    v.minFilter = THREE.LinearMipmapLinearFilter;
    v.magFilter = THREE.LinearFilter;
  }

  // Keyed on the mipmap minFilter, so the spectrum/butterfly targets (which
  // read exact texel centers and stay NearestFilter) are left alone.
  const aniso = Math.min(ANISOTROPY, renderer.capabilities.getMaxAnisotropy());
  const createRT = gpu.createRenderTarget;
  gpu.createRenderTarget = function (...args) {
    const rt = createRT.apply(this, args);
    if (rt.texture.minFilter === THREE.LinearMipmapLinearFilter) {
      rt.texture.generateMipmaps = true;
      rt.texture.anisotropy = aniso;
    }
    return rt;
  };

  // gpu.init() compiles and renders every one of the ~50 pass programs in a
  // single blocking call. It cannot be split, so the loading screen at least
  // says what it is waiting on before the thread goes away.
  yield { label, detail: `compiling ${2 * stages + 5} passes`, fraction: 0.9 };
  const err = gpu.init();
  gpu.createRenderTarget = createRT;
  if (err) throw new Error(`GPUComputationRenderer init failed: ${err}`);
  yield { label, detail: "ready", fraction: 1 };

  return {
    params: o,
    // Debug handle for live browser eval (Jacobian/foam/mip probing).
    debug: { gpu, combine, foam, specA, specB, specC, fftEnd },
    update(dt: number, t: number) {
      specA.material.uniforms.uTime.value = t;
      specB.material.uniforms.uTime.value = t;
      specC.material.uniforms.uTime.value = t;
      foam.material.uniforms.uDeltaT.value = Math.min(Math.max(dt, 1 / 240), 0.1);
      gpu.compute();
    },
    displacementTexture: () => gpu.getCurrentRenderTarget(combine).texture,
    // The target behind displacementTexture(), for readback. RGBA is
    // (dx, height, dz, Jacobian) in FloatType, so one texel of it is the
    // wave height at a world position -- the only way to learn the real
    // surface height on the CPU without re-simulating it there.
    displacementTarget: () => gpu.getCurrentRenderTarget(combine),
    // GPUComputationRenderer ping-pongs every variable. The alternate target
    // is last frame's displacement and can feed ocean motion vectors without
    // another simulation or texture copy.
    previousDisplacementTexture: () => gpu.getAlternateRenderTarget(combine).texture,
    foamTexture: () => gpu.getCurrentRenderTarget(foam).texture,
  };
}

/** Builds an FFT cascade in one blocking task. See {@link buildOceanFft}. */
export function createOceanFft(renderer: THREE.WebGLRenderer, opts: OceanFftOptions = {}) {
  return drain(buildOceanFft(renderer, opts));
}
