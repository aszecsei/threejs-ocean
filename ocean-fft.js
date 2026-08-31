import * as THREE from "three";
import { GPUComputationRenderer } from "three/addons/misc/GPUComputationRenderer.js";

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
  ampScale: null,
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
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const G = 9.81;

// Options merge that reaches into swellSpectrum, so a caller can override one
// swell field without silently dropping the rest of the block.
function mergeOpts(c) {
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
const dispersion = (k, depth) => Math.sqrt(G * k * Math.tanh(Math.min(k * depth, 20)));

// |domega/dk|, which folds the k-space cell into the amplitude. Without it a
// spectral density in omega is being read as one in k and the balance between
// long and short waves is wrong.
function dispersionDerivative(k, depth) {
  const kd = Math.min(k * depth, 20);
  const th = Math.tanh(kd);
  const ch = Math.cosh(kd);
  return (G * ((depth * k) / (ch * ch) + th)) / dispersion(k, depth) / 2;
}

function tmaCorrection(omega, depth) {
  const oh = omega * Math.sqrt(depth / G);
  if (oh <= 1) return 0.5 * oh * oh;
  if (oh < 2) return 1 - 0.5 * (2 - oh) * (2 - oh);
  return 1;
}

function jonswap(omega, depth, p) {
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
function normalisationFactor(s) {
  const s2 = s * s, s3 = s2 * s, s4 = s3 * s;
  return s < 5
    ? -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163
    : -4.8e-8 * s4 + 1.07e-5 * s3 - 9.53e-4 * s2 + 5.9e-2 * s + 3.93e-1;
}

function directionSpectrum(theta, omega, p) {
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
function resolveSpectra(o) {
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
  for (const p of out) {
    p.alpha = 0.076 * Math.pow((G * p.fetch) / (p.windSpeed * p.windSpeed), -0.22);
    p.peakOmega = 22 * Math.pow((p.windSpeed * p.fetch) / (G * G), -0.33);
  }
  return out;
}

// Per-mode height variance at unit amplitude scale, zero outside the
// cascade's wavenumber band. This is the `2 S |domega/dk| / k` of the
// reference implementation; multiplying by dk^2 gives the mode's variance,
// which is exactly what the old Phillips `P` was being used as. Shared by
// buildH0Texture and spectrumVariance so the two can never disagree about
// what a cascade contains.
function waveSpectrum(kx, kz, depth, specs, kLow, kHigh) {
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
export function spectrumVariance(c) {
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
  }
  return v * dk * dk;
}

// Amplitude scale that makes a *set* of cascades add up to heightRms of RMS
// wave height. Their variances sum, so normalizing each one on its own would
// make the sea grow every time a cascade is added.
export function cascadeAmpScale(cascades, heightRms) {
  let v = 0;
  for (const c of cascades) v += spectrumVariance(c);
  return v > 0 ? heightRms / Math.sqrt(v) : 0;
}

// --- h0 spectrum texture ----------------------------------------------------
// RG = h0(k) = gaussian * sqrt(P(k)); BA = conj(h0(-k)) (mirrored texel).
// Amplitudes carry the shared ampScale, so expected RMS wave height across
// all cascades == heightRms world units — makes the height knob physical
// and independent of both `size` and the cascade count.
function buildH0Texture(o, ampScale) {
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
function buildButterflyTexture(N) {
  const stages = Math.round(Math.log2(N));
  const data = new Float32Array(N * stages * 4);
  for (let s = 1; s <= stages; s++) {
    const span = 1 << s;
    const m = span >> 1;
    for (let j = 0; j < N; j++) {
      const r = j % span;
      let a, b, sign, ang;
      if (r < m) {
        a = j; b = j + m; sign = 1;
        ang = (2 * Math.PI * r) / span;
      } else {
        a = j - m; b = j; sign = -1;
        ang = (2 * Math.PI * (r - m)) / span;
      }
      const idx = ((s - 1) * N + j) * 4;
      data[idx + 0] = a;
      data[idx + 1] = b;
      data[idx + 2] = sign * Math.cos(ang);
      data[idx + 3] = sign * Math.sin(ang);
    }
  }
  const tex = new THREE.DataTexture(data, N, stages, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// --- Shaders ----------------------------------------------------------------

// Time evolution. Writes the spectrum at BIT-REVERSED positions (both axes)
// so the subsequent DIT butterflies emit natural order directly.
const SPECTRUM_SHADER = /* glsl */ `
  uniform sampler2D uH0;
  uniform float uTime;
  uniform float uSize;
  uniform float uBits;
  uniform float uPatchSize;
  uniform float uDepth;

  // GLSL ES 1.00 has no tanh. Argument is k*depth, never negative.
  float tanhf(float x) {
    float e = exp(-2.0 * min(x, 20.0));
    return (1.0 - e) / (1.0 + e);
  }

  vec2 cmul(vec2 a, vec2 b) {
    return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
  }

  float bitrev(float x) {
    float r = 0.0;
    for (int i = 0; i < 12; i++) {
      if (float(i) >= uBits) break;
      r = r * 2.0 + mod(x, 2.0);
      x = floor(x * 0.5);
    }
    return r;
  }

  void main() {
    vec2 p = floor(gl_FragCoord.xy);
    float n = bitrev(p.x);
    float m = bitrev(p.y);

    float sn = (n <= 0.5 * uSize) ? n : n - uSize;
    float sm = (m <= 0.5 * uSize) ? m : m - uSize;
    vec2 k = vec2(sn, sm) * (6.2831853 / uPatchSize);
    float klen = length(k);
    float klenS = max(klen, 1e-5);

    // Must match dispersion() in this file exactly — same clamp, same
    // form. The CPU picks amplitudes for these waves; if the GPU then
    // evolves different ones, the spectrum and the motion disagree.
    float w = sqrt(9.81 * klenS * tanhf(klenS * uDepth));
    vec2 epos = vec2(cos(w * uTime), sin(w * uTime));
    vec2 eneg = vec2(epos.x, -epos.y);

    vec4 h0  = texture2D(uH0, (vec2(n, m) + 0.5) / uSize);
    vec2 nc  = vec2(mod(uSize - n, uSize), mod(uSize - m, uSize));
    vec4 h0c = texture2D(uH0, (nc + 0.5) / uSize);

    vec2 h = cmul(h0.xy, epos) + cmul(h0.zw, eneg);
    vec2 khat = k / klenS;
    // Choppy (Gerstner) spectrum: D~ = +i * khat * h~. Tessendorf writes
    // -i, but that assumes a e^{-ikx} transform; our butterflies use
    // e^{+ikx} (see buildButterflyTexture), and with that sign the +i
    // form is what moves points TOWARD crests (h = cos(kx) -> D = -sin(kx)).
    // Using -i here pinches the troughs instead and foams the valleys.
    vec2 iH = vec2(-h.y, h.x); // i * h

    #if defined(CHAIN_C)
      // RG = dh/dx spectrum, BA = dh/dz spectrum. Note the RAW k, not khat:
      // the choppy chains normalize the wavevector, the slope chains must
      // not — d/dx of e^{+ikx} is +i*k.x, unnormalized. Same +i as the
      // choppy term for the same reason (our kernel is e^{+ikx}).
      gl_FragColor = vec4(iH * k.x, iH * k.y);
    #elif defined(CHAIN_B)
      // RG = choppy-z spectrum, BA unused
      gl_FragColor = vec4(iH * khat.y, vec2(0.0));
    #else
      // RG = height spectrum, BA = choppy-x spectrum
      gl_FragColor = vec4(h, iH * khat.x);
    #endif
  }
`;

// One radix-2 butterfly stage. Reads the precomputed butterfly table
// (index pair + twiddle with sign folded in) and combines two input texels.
function fftShader(depName) {
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
function combineShader(nameA, nameB) {
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
function foamShader(nameC) {
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
export function createOceanFft(renderer, opts = {}) {
  const o = mergeOpts(opts);
  const N = o.size;
  const stages = Math.round(Math.log2(N));
  if (1 << stages !== N) throw new Error(`FFT size must be a power of two (got ${N})`);

  const gpu = new GPUComputationRenderer(N, N, renderer);
  gpu.setDataType(THREE.FloatType);

  const ampScale = o.ampScale ?? cascadeAmpScale([o], o.heightRms);
  const h0Tex = buildH0Texture(o, ampScale);
  const butterflyTex = buildButterflyTexture(N);
  const dummy = gpu.createTexture();
  // Seed for the combine stage: a flat surface has Jacobian 1, not 0.
  // GPUComputationRenderer feeds each variable its dependencies' previous
  // outputs, so for the first ~2*stages frames the foam pass reads this seed
  // (and then a still-flat surface); a zero Jacobian there injects full foam
  // over the whole sea that then takes seconds to decay.
  const flatSeed = gpu.createTexture();
  {
    const px = flatSeed.image.data;
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

  const fftEnd = {};
  const specOf = { A: specA, B: specB, C: specC };
  for (const chain of ["A", "B", "C"]) {
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

  const err = gpu.init();
  gpu.createRenderTarget = createRT;
  if (err) throw new Error(`GPUComputationRenderer init failed: ${err}`);

  return {
    params: o,
    // Debug handle for live browser eval (Jacobian/foam/mip probing).
    debug: { gpu, combine, foam, specA, specB, specC, fftEnd },
    update(dt, t) {
      specA.material.uniforms.uTime.value = t;
      specB.material.uniforms.uTime.value = t;
      specC.material.uniforms.uTime.value = t;
      foam.material.uniforms.uDeltaT.value = Math.min(Math.max(dt, 1 / 240), 0.1);
      gpu.compute();
    },
    displacementTexture: () => gpu.getCurrentRenderTarget(combine).texture,
    // GPUComputationRenderer ping-pongs every variable. The alternate target
    // is last frame's displacement and can feed ocean motion vectors without
    // another simulation or texture copy.
    previousDisplacementTexture: () => gpu.getAlternateRenderTarget(combine).texture,
    foamTexture: () => gpu.getCurrentRenderTarget(foam).texture,
  };
}
