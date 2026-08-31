// High-altitude cirrus as a 2.5-D scrolling layer (HZD/RDR2-style): one
// analytic plane intersection and one 2D density lookup instead of a march.
//
// View-shader only -- deliberately kept out of density.glsl so the shadow map
// and the light march never see it.
//
// Requires hgPhase() and desat() to be declared before this chunk; it uses
// them for the single-sample ice-crystal lighting. The cloud view shader
// injects them ahead of this file.
#ifdef CLOUD_CIRRUS
  uniform sampler2D tCloudCirrusNoise;

  struct CirrusSample { float coverage; float type; float density; };

  // 2.5-D density on the cirrus plane. The HFW model: streaky/wispy/round
  // basis fields selected by a type scalar, coverage driving both a power
  // curve (contrast) and a cubic occupancy mask. Basis lookups happen in a
  // wind-aligned frame so the anisotropic stretch follows the upper-level
  // wind, which is decoupled from the low layer's WIND_DIR.
  CirrusSample cirrusField(vec2 xz) {
    // Weather domain lives in the wind frame, stretched 2.5x along the wind
    // so coverage regions are elongated systems, not round blobs. Scroll
    // reduces to +x after the rotation.
    vec2 wr = CIRRUS_WIND_ROT * xz;
    vec2 w = vec2(wr.x * 0.4, wr.y) * CIRRUS_WEATHER_SCALE
      + vec2(uTime * CIRRUS_WIND_SPEED * (CIRRUS_WEATHER_SCALE / CIRRUS_NOISE_SCALE) * 0.4, 0.0);
    // Regional influence (bake channel A) gates where streak systems live;
    // a mid-frequency band shapes them inside those regions. Same composed
    // idiom as cloudWeather, one octave larger — cirrus systems are broad.
    // The baked fBm occupies ~[0.38, 0.72]; stretch to full range so the
    // coverage threshold below has the whole band to bite into (same
    // narrow-numeric-range issue the base 3D bake documents).
    // Regional frequency sized so several systems fit the visible span of
    // the layer (~30k units at grazing angles): one cell ~8k units. Any
    // lower and the sky alternates between empty and fully veiled.
    float region = clamp(cloudRemap(texture(tCloudCirrusNoise, w * 0.7 + vec2(0.13, 0.71)).a, 0.38, 0.72, 0.0, 1.0), 0.0, 1.0);
    float form = cloudVnoise(vec3(w * 2.2 + vec2(7.7, -2.9), 31.7));
    // Wide threshold band placed by CIRRUS_COVERAGE: a narrow band makes C
    // effectively binary and every system renders as a uniform slab. The
    // wide band grades C smoothly across a system so the power/mask shaping
    // below produces thin translucent skirts around denser cores.
    float sigLo = 0.92 - CIRRUS_COVERAGE * 0.75;
    float C = clamp(cloudRemap(region * 0.6 + form * 0.4, sigLo, sigLo + 0.45, 0.0, 1.0), 0.0, 1.0);
    float T = clamp(CIRRUS_TYPE + (texture(tCloudCirrusNoise, w * 0.9 + vec2(0.41, 0.07)).a - 0.5) * 0.6, 0.0, 1.0);
    // Wind-frame basis coordinates; scroll reduces to +x after rotation.
    vec2 q = CIRRUS_WIND_ROT * xz * CIRRUS_NOISE_SCALE + vec2(uTime * CIRRUS_WIND_SPEED, 0.0);
    vec2 curl = texture(tCloudCurlNoise, q * 0.7).rg * 2.0 - 1.0;
    // Streaks: strong stretch along wind, curl bends them mostly crosswise
    // so filaments curve instead of shearing into straight lines.
    vec2 streakUv = vec2(q.x / CIRRUS_STRETCH, q.y) + curl * CIRRUS_CURL_STRENGTH * vec2(0.3, 1.0);
    float Ns = texture(tCloudCirrusNoise, streakUv).r;
    vec2 wispUv = vec2(q.x / (CIRRUS_STRETCH * 0.35), q.y) + curl * (CIRRUS_CURL_STRENGTH * 2.2);
    float Nw = texture(tCloudCirrusNoise, wispUv).g;
    float Nr = texture(tCloudCirrusNoise, q * 1.4).b;
    float N = cloudRemap(clamp(T, 0.5, 1.0), 0.5, 1.0,
      cloudRemap(clamp(T, 0.0, 0.5), 0.0, 0.5, Ns, Nw), Nr);
    // HFW's published power range is +-0.9, but at C~1 that flattens the
    // basis to N^0.1 ~ 1 and cores become featureless slabs; +-0.55 keeps
    // filament texture alive inside dense systems.
    float D = pow(max(N, 1e-4), 1.0 - cloudRemap(C, 0.0, 1.0, -0.55, 0.55));
    D *= clamp(cloudRemap(C * C * C, 0.0, 0.5, 0.0, 1.0), 0.0, 1.0);
    return CirrusSample(C, T, clamp(D, 0.0, 1.0));
  }

  float cirrusIntersect(vec3 eye, vec3 dir) {
    if (dir.y <= 0.002 || eye.y >= CIRRUS_ALT) return -1.0;
    return (CIRRUS_ALT - eye.y) / dir.y;
  }

  // Single-sample ice-crystal lighting, premultiplied (rgb, a). Optical
  // depth gets a slant boost as the thin-slab thickness proxy; the phase is
  // a strong forward lobe (ice crystals) softened by a broad lobe, with a
  // Beer self-shadow at half depth. No light march — the layer is too thin
  // to shadow itself meaningfully. The same aerial haze as the low clouds,
  // at the plane distance, dissolves it into the sky toward the horizon.
  vec4 cirrusApply(CirrusSample c, vec3 dir, float tC, float mu, float airMass, vec3 skyBehind, bool maskOnly) {
    if (c.density <= 0.003) return vec4(0.0);
    // Slant floor at 0.25 caps the thickness boost near the horizon; the
    // aerial haze below owns the horizon falloff, and an uncapped 1/dir.y
    // saturates the whole lower sky into a slab.
    float od = c.density * CIRRUS_OPTICAL_DEPTH / max(dir.y, 0.25);
    float alpha = 1.0 - exp(-od);
    if (maskOnly) return vec4(0.0, 0.0, 0.0, alpha);
    // The veil must read brighter than the Rayleigh-blue sky behind it —
    // cirrus scatters broad-spectrum sunlight. The broad lobe carries most
    // of the away-from-sun brightness; the tight lobe adds the near-sun
    // glare; the ambient sits at full sky scale (an under-scaled ambient
    // composites cirrus as a gray smear darker than the sky).
    float phase = mix(hgPhase(mu, 0.78), hgPhase(mu, 0.20), 0.55);
    vec3 lum = uSunColor * phase * exp(-od * 0.5) * 6.0
      + desat(mix(uZenithColor, uHorizonColor, 0.35), 0.30) * 1.05 + vec3(0.05);
    float haze = 1.0 - exp(-tC * airMass / HAZE_DIST);
    lum = mix(lum, skyBehind, haze);
    return vec4(lum * alpha, alpha);
  }
#endif
