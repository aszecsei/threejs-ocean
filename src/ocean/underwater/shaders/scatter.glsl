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
  uniform vec3 uWaterIrradiance;  // E_D0, just under the surface
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
   * `a` is negative for every preset (Kd < sigma_t componentwise, and
   * dirY <= 1), so the pole at a = 0 is unreachable; the clamp only insures
   * against a hand-edited coefficient set.
   */
  vec3 waterMultiScatter(float originDepth, float dirY, float s) {
    vec3 a = min(uWaterKd * dirY - uWaterSigmaT, vec3(-1e-3));
    vec3 integral = (exp(a * max(s, 0.0)) - 1.0) / a;
    return uWaterSigmaS * waterDownwelling(originDepth) * integral / (4.0 * WATER_PI);
  }

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
    float phase = waterPhase(dot(dir, uWaterSunDirection));
    vec3 sum = vec3(0.0);
    for (int i = 0; i < WATER_SHAFT_STEPS; i++) {
      float t = (float(i) + jitter) * dt;
      vec3 p = origin + dir * t;
      float depth = max(uWaterLevel - p.y, 0.0);
      vec3 sun = exp(-uWaterSigmaT * (depth * sunRun));
      sum += sun * waterCaustic(p, depth) * exp(-uWaterSigmaT * t);
    }
    return uWaterSigmaS * uWaterIrradiance * phase * sum * dt;
  }
  #endif
