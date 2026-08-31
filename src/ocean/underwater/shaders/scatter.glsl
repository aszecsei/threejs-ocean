// The water body as a participating medium.
//
// Included by the underwater resolve pass and by the ocean surface's underside
// branch, so the volume and the surface that bounds it agree by construction.
// Declares nothing but functions -- the coefficients arrive as uniforms shared
// by identity from createWaterMedium (water.ts).
//
// Model: Monzon, Akkaynak, Gutierrez & Munoz, "Real-time rendering of
// underwater scenes based on data and an approximation to multiple
// scattering", CEIG 2023 (docs/TFM_underwater_rendering_CEIG2023.pdf).
// In-scattering splits into a low-frequency multiple-scattering term, which
// their Eq. 4 solves in closed form, and a high-frequency single-scattering
// term, which still has to be marched.

  uniform float uWaterIor;        // ~1.333; its critical angle is ~48.6 deg
  uniform vec3 uWaterSigmaS;      // scattering, m^-1
  uniform vec3 uWaterSigmaT;      // extinction = absorption + scattering, m^-1
  uniform vec3 uWaterKd;          // diffuse downwelling attenuation, m^-1
  uniform vec3 uWaterIrradiance;  // E_D0 (sun + sky), just under the surface
  uniform vec3 uWaterSunIrradiance; // the sun's share of it, alone
  uniform vec3 uWaterSunDirection; // sun after refraction, pointing downward
  uniform float uWaterLevel;
  uniform float uWaterPhaseG;
  uniform float uWaterCameraDepth;

  const float WATER_PI = 3.14159265;

  /** Beer-Lambert transmittance over `s` metres of water. */
  vec3 waterTransmittance(float s) {
    return exp(-uWaterSigmaT * max(s, 0.0));
  }

  /** Downwelling irradiance at `depth` metres below the surface. */
  vec3 waterDownwelling(float depth) {
    return uWaterIrradiance * exp(-uWaterKd * max(depth, 0.0));
  }

  /** Henyey-Greenstein phase function; `mu` is cos(scattering angle). */
  float waterPhase(float mu) {
    float g = uWaterPhaseG;
    float g2 = g * g;
    float d = 1.0 + g2 - 2.0 * g * mu;
    return (1.0 - g2) / (4.0 * WATER_PI * max(d * sqrt(max(d, 1e-6)), 1e-4));
  }

  /**
   * Multiple scattering along a ray, in closed form (Eq. 4).
   *
   * Substituting the oceanographic law E_D(y) = E_D0 * exp(-Kd * y) for the
   * in-scattered radiance -- multiple scattering is low-frequency enough that
   * treating it as depth-only is a good approximation -- and an isotropic
   * phase function collapses two nested integrals into one expression:
   *
   *   L = sigma_s * exp(-Kd*o_y) * E_D0 / (4pi (Kd*w_y - sigma_t))
   *       * (exp((Kd*w_y - sigma_t) * S) - 1)
   *
   * `originDepth` is o_y, metres below the surface; `dirY` is the ray's
   * upward component w_y; `s` is the path length S through water.
   *
   * `a` is negative for every preset -- Kd < sigma_t in every channel, which
   * physics requires and test/underwater.test.ts enforces, and dirY is at
   * most 1 -- so the pole at a = 0 is unreachable. The clamp is insurance
   * against a hand-edited coefficient set, not the thing keeping it finite.
   */
  vec3 waterMultiScatter(float originDepth, float dirY, float s) {
    vec3 a = min(uWaterKd * dirY - uWaterSigmaT, vec3(-1e-3));
    vec3 integral = (exp(a * max(s, 0.0)) - 1.0) / a;
    return uWaterSigmaS * waterDownwelling(originDepth) * integral / (4.0 * WATER_PI);
  }

  #ifdef WATER_CAUSTICS
  uniform sampler2D tCaustic;
  uniform vec2 uCausticCenter;
  uniform float uCausticExtent;
  uniform float uCausticPlaneY;
  uniform float uCausticStrength;

  /**
   * How much brighter or darker than an unrippled sea the sunlight is here.
   * 1 is "as if the surface were flat".
   *
   * The map is indexed by where light *lands*, so a point in mid-water has to
   * be walked down its refracted sun ray to the floor before the map is read
   * -- which is what makes a shaft carry the banding of the patch of sand it
   * ends on rather than a pattern of its own. `aboveFloor` is how far it has
   * to travel: zero for a point already on the sand, whose landing point is
   * itself and which the splat has already placed exactly.
   */
  float waterCaustic(vec3 p, float aboveFloor) {
    float t = max(aboveFloor, 0.0) / max(-uWaterSunDirection.y, 0.05);
    vec2 q = p.xz + uWaterSunDirection.xz * t;
    vec2 uv = (q - uCausticCenter) / uCausticExtent + 0.5;
    // Fade to unity at the rim, so the map's edge is a change in contrast
    // rather than a visible square drawn on the sea floor.
    vec2 e = smoothstep(0.0, 0.08, uv) * smoothstep(1.0, 0.92, uv);
    float edge = e.x * e.y;
    if (edge <= 0.0) return 1.0;
    float c = texture2D(tCaustic, uv).r;
    return mix(1.0, 1.0 + (c - 1.0) * uCausticStrength, edge);
  }
  #else
  /**
   * Caustic intensity with no map: unit everywhere, so callers multiply by it
   * unconditionally and never carry a branch of their own.
   */
  float waterCaustic(vec3 p, float aboveFloor) { return 1.0; }
  #endif

  #ifdef WATER_SHAFTS
  /**
   * Single scattering of direct sunlight, marched. This is the term that
   * produces the shafts, so it is the one that has to see the caustic
   * banding; the closed form above deliberately cannot.
   *
   * Follows Papadopoulos & Papaioannou (GraphiCon 09) per sample:
   *   I = I_sun * phase(theta) * exp(-sigma_t * d_fromViewer)
   *              * exp(-sigma_t * d_fromSurface)
   * gathered along the view ray rather than splatted as line primitives.
   * `jitter` in [0,1) offsets the samples so the banding becomes noise for
   * TAA to average away.
   */
  vec3 waterSingleScatter(vec3 origin, vec3 dir, float s, float jitter) {
    if (s <= 0.0) return vec3(0.0);
    float dt = s / float(WATER_SHAFT_STEPS);
    // Sun transmittance is measured along the refracted ray, so a metre of
    // depth costs more than a metre of path when the sun is low.
    float sunRun = 1.0 / max(-uWaterSunDirection.y, 0.05);
    // uWaterSunDirection is the direction the light *travels*, which is
    // downward, so the scattering angle is measured against its negation --
    // the direction the sun is in. Backwards, this puts the forward lobe
    // behind the viewer: with g = 0.7 the peak and the trough differ by a
    // factor of 180, so the shafts disappear in precisely the direction you
    // have to look to see them.
    float phase = waterPhase(-dot(dir, uWaterSunDirection));
    vec3 sum = vec3(0.0);
    for (int i = 0; i < WATER_SHAFT_STEPS; i++) {
      float t = (float(i) + jitter) * dt;
      vec3 p = origin + dir * t;
      float depth = max(uWaterLevel - p.y, 0.0);
      vec3 sun = exp(-uWaterSigmaT * (depth * sunRun));
      sum += sun * waterCaustic(p, p.y - uCausticPlaneY) * exp(-uWaterSigmaT * t);
    }
    return uWaterSigmaS * uWaterSunIrradiance * phase * sum * dt * WATER_SHAFT_STRENGTH;
  }
  #endif
