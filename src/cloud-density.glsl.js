// One density implementation is injected into the view and shadow shaders.
// Callers provide the geometry/shape defines and the uniforms declared here.
export const CLOUD_DENSITY_GLSL = /* glsl */ `
  uniform float uTime;
  uniform sampler3D tCloudBaseNoise;
  uniform sampler3D tCloudDetailNoise;
  uniform sampler2D tCloudCurlNoise;

  const vec2 WIND_DIR = vec2(1.0, 0.35);

  float cloudHash13(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  vec3 cloudHash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float cloudVnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(cloudHash13(i), cloudHash13(i + vec3(1,0,0)), f.x),
          mix(cloudHash13(i + vec3(0,1,0)), cloudHash13(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(cloudHash13(i + vec3(0,0,1)), cloudHash13(i + vec3(1,0,1)), f.x),
          mix(cloudHash13(i + vec3(0,1,1)), cloudHash13(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float cloudWorley(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    float md = 1.0;
    for (int z=-1; z<=1; z++) for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 r = g + cloudHash33(i + g) - f;
      md = min(md, dot(r, r));
    }
    return sqrt(md);
  }
  float cloudWorleyFbm(vec3 p) {
    return (1.0-cloudWorley(p))*0.625 + (1.0-cloudWorley(p*2.0+7.3))*0.375;
  }
  const mat3 CLOUD_NOISE_ROT = mat3(0.0,0.8,0.6, -0.8,0.36,-0.48, -0.6,-0.48,0.64);
  float cloudFbm(vec3 p, const int octaves) {
    float sum=0.0, norm=0.0, amp=1.0, freq=1.0;
    for (int i=0; i<5; i++) {
      if (i >= octaves) break;
      sum += amp * cloudVnoise(p * freq); norm += amp;
      amp *= 0.5; freq *= 2.3; p = CLOUD_NOISE_ROT * p;
    }
    return sum / max(norm, 1e-4);
  }
  float cloudRemap(float v, float lo, float hi, float nlo, float nhi) {
    return nlo + (v-lo) / max(hi-lo, 1e-5) * (nhi-nlo);
  }

  struct CloudWeather { float coverage; float type; float tower; float rawCoverage; };
  CloudWeather cloudWeather(vec2 xz) {
    vec2 w = xz * WEATHER_SCALE
      + uTime * WIND_SPEED * (WEATHER_SCALE / NOISE_SCALE) * WIND_DIR;
    // Composed cloud map (Nubis-style) instead of a plain octave sum: a slow
    // air-mass field gates where formations exist, mid-frequency noise shapes
    // the hero masses inside those regions, and a high band shreds their
    // skirts into satellite clumps and connective wisps. The remaps preserve
    // dense cores; a weighted sum here just makes evenly scattered blobs.
    float nA = cloudVnoise(vec3(w*0.35 + vec2(3.1, -7.7), 5.3));
    float nF = cloudVnoise(vec3(w, 3.7))*0.70
             + cloudVnoise(vec3(w*2.3+11.0, 9.1))*0.30;
    float nH = cloudVnoise(vec3(w*2.7 + vec2(-13.7, 5.9), 21.3));
    float airGate = clamp(cloudRemap(nA, AIRMASS_CLEAR, AIRMASS_FULL, 0.0, 1.0), 0.0, 1.0);
    // The max() floors the remap slope: a weak air mass still gates clouds
    // out, but without razor-steep coverage cliffs at formation edges (they
    // dither badly through the half-res reconstruction). Weak-gate regions
    // simply never reach full coverage, which reads as thinner clouds.
    float formation = clamp((nF - (1.0 - airGate)) / max(airGate, 0.5), 0.0, 1.0);
    float breakup = BREAKUP*nH*(1.0-formation);
    float nC = clamp(cloudRemap(formation, breakup, 1.0, 0.0, 1.0), 0.0, 1.0);
    #ifdef CLOUD_WEATHER_SPLIT
      vec2 wt = w * 0.83 + vec2(17.31, -9.27);
      float nT = cloudVnoise(vec3(wt, 15.7))*0.70
               + cloudVnoise(vec3(wt*2.1+vec2(-5.4,13.8), 27.1))*0.30;
      float C = clamp(cloudRemap(nC, COVERAGE_CLEAR, COVERAGE_OVERCAST, 0.0, 1.0), 0.0, 1.0);
      float Ti = clamp(cloudRemap(nT, TYPE_LOW, TYPE_HIGH, 0.0, 1.0), 0.0, 1.0);
      float T = mix(Ti, C, TYPE_CORRELATION);
      float towerType = smoothstep(TOWER_TYPE_START, TOWER_TYPE_FULL, T);
      float towerCoverage = smoothstep(TOWER_COVERAGE_MIN, TOWER_COVERAGE_FULL, C);
      return CloudWeather(C, T, towerType*towerCoverage, nC);
    #else
      float tower = smoothstep(TOWER_THRESHOLD, TOWER_THRESHOLD+TOWER_BAND, nC);
      float C = clamp(1.0-COVERAGE + (nC-0.5)*0.25 + tower*0.18, 0.0, 1.0);
      return CloudWeather(C, nC, tower, nC);
    #endif
  }

  struct CloudSample {
    float density;
    float height;
    float profile;
    float coverage;
    float type;
    float tower;
    float baseNoise;
    float detailNoise;
  };

  vec3 cloudNoiseCoordinates(vec3 p, float tower, float height, out vec3 detailQ) {
    vec3 q = p * NOISE_SCALE;
    vec2 wind = uTime * WIND_SPEED * WIND_DIR;
    detailQ = (q + vec3(wind.x,0.0,wind.y))*EROSION_SCALE;
    // Horizontal compression of the base domain stretches cloud masses
    // ~1.6x along the wind plane: elongated streaky bodies instead of round
    // balloons, which is most of what reads as "wispy" at distance.
    q.xz *= mix(0.62,0.45,tower);
    q.y *= mix(1.0,0.7,tower);
    q.xz += wind;
    // Divergence-free curl turbulence distorts the detail lookup, strongest
    // at the cloud base so undersides erode into wisps; tops keep a reduced
    // share so they streak instead of staying perfectly round.
    vec3 curl = texture(tCloudCurlNoise, q.xz*0.35).rgb*2.0-1.0;
    detailQ += curl*CURL_STRENGTH*(1.0-0.55*height);
    // Vertically compressed detail domain near the base: erosion then carves
    // horizontally stretched laminae (wisps) instead of round Worley blobs.
    detailQ.y *= mix(1.7, 1.05, height);
    // Horizontally-weighted warp smears the base masses into streaks rather
    // than displacing them as intact blobs.
    float warp = cloudVnoise(q*1.5 + vec3(0.0,uTime*0.015,0.0));
    q += (warp-0.5)*vec3(0.7,0.25,0.7);
    return q;
  }

  float cloudBaseSignal(vec3 q, const int octaves, const bool detailed) {
    #ifdef CLOUD_NOISE_TEXTURE
      vec4 b0 = texture(tCloudBaseNoise, q*0.18);
      // R already carries the Worley-fBm-dilated, renormalized occupancy
      // envelope (baked in float precision). Both coarse and fine density use
      // it identically; fine-only GBA and the second decorrelated read enter
      // erosion below, never the occupied-region test.
      return b0.r;
    #else
      return cloudFbm(q, octaves);
    #endif
  }
  float cloudDetailSignal(vec3 q) {
    // Two frequencies an octave-and-a-half apart; a single band reads as
    // uniformly-sized bumps, which is most of the "cartoon" look.
    #ifdef CLOUD_NOISE_TEXTURE
      vec3 d = texture(tCloudDetailNoise, q*0.25).rgb;
      vec3 d2 = texture(tCloudDetailNoise, q*0.83 + vec3(0.5)).rgb;
      return dot(d, vec3(0.45,0.35,0.20))*0.62 + dot(d2, vec3(0.40,0.35,0.25))*0.38;
    #else
      return cloudWorleyFbm(q)*0.62 + cloudWorleyFbm(q*3.3+11.7)*0.38;
    #endif
  }

  // detailFade in [0,1] LODs the erosion: 1 = full edge detail, 0 = none.
  // Distant samples cannot resolve the erosion frequency and dissolve into
  // speckle, so the marcher fades it out with distance.
  CloudSample sampleCloudDensityLod(vec3 p, const int octaves, const bool erode, float detailFade) {
    CloudSample s = CloudSample(0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0);
    if (p.y < CLOUD_BOTTOM || p.y > CB_TOP) return s;
    vec2 shearedXZ = p.xz + WIND_DIR*(ANVIL_SHEAR*(p.y-CLOUD_BOTTOM));
    CloudWeather weather = cloudWeather(shearedXZ);
    s.coverage=weather.coverage; s.type=weather.type; s.tower=weather.tower;
    float turret=0.75+0.25*cloudVnoise(vec3(shearedXZ*(WEATHER_SCALE*5.0),1.3));
    float top=mix(CU_TOP,CB_TOP,smoothstep(0.0,0.6,s.tower)*turret);
    s.height=(p.y-CLOUD_BOTTOM)/max(top-CLOUD_BOTTOM,1e-4);
    if (s.height<0.0 || s.height>1.0) return s;
    float cu=smoothstep(0.0,0.18,s.height)*(1.0-smoothstep(0.72,1.0,s.height));
    float cb=smoothstep(0.0,0.06,s.height)*(1.0-smoothstep(0.93,1.0,s.height));
    #ifdef CLOUD_WEATHER_SPLIT
      float sc=smoothstep(0.0,0.10,s.height)*(1.0-smoothstep(0.45,0.68,s.height));
      float lowType=smoothstep(TYPE_STRATO,TYPE_CUMULUS,s.type);
      s.profile=mix(mix(sc,cu,lowType),cb,s.tower);
    #else
      s.profile=mix(cu,cb,s.tower);
    #endif
    if (s.profile<=0.0) return s;
    vec3 detailQ;
    vec3 q=cloudNoiseCoordinates(vec3(shearedXZ.x,p.y,shearedXZ.y),s.tower,s.height,detailQ);
    s.baseNoise=cloudBaseSignal(q,octaves,erode);
    #ifdef CLOUD_MID_BAND
      // Experimental band filling the ~50-80 unit gap between base billows
      // and the detail erosion, so clouds stop being 2-5 same-size lumps.
      // It perturbs the base signal before the coverage threshold — shape,
      // not erosion — so the coarse march and shadows see the same clumps
      // as the fine march and cannot skip over them.
      #ifdef CLOUD_NOISE_TEXTURE
        float midBand=dot(texture(tCloudBaseNoise,q*0.36+vec3(0.31,0.17,0.59)).ba,vec2(0.55,0.45));
      #else
        float midBand=1.0-cloudWorley(q*3.85+vec3(13.1,7.3,3.7));
      #endif
      s.baseNoise=clamp(s.baseNoise+(midBand-0.5)*MID_BAND_STRENGTH*(0.4+0.6*detailFade),0.0,1.0);
    #endif
    s.detailNoise=0.0;
    if (erode) {
      s.detailNoise=cloudDetailSignal(detailQ);
      #ifdef CLOUD_NOISE_TEXTURE
        vec4 baseDetail=texture(tCloudBaseNoise,q*0.18);
        vec4 baseDetail2=texture(tCloudBaseNoise,q.zyx*0.127+vec3(0.37,0.11,0.73));
        float packedWorley=dot(baseDetail.gba,vec3(0.55,0.30,0.15));
        s.detailNoise=mix(s.detailNoise,packedWorley*0.75+baseDetail2.r*0.25,0.50);
      #endif
    }
    // Widen the threshold band as detail fades with distance: far features
    // are subpixel, and a hard edge there dissolves into binary crumbs.
    float shapeWidth=SHAPE_WIDTH*mix(2.4,1.0,detailFade);
    float envelope=1.0;
    #ifdef CLOUD_PROFILE_DIMENSIONAL
      float anvilHeight=smoothstep(0.70,0.80,s.height);
      float anvilExponent=mix(1.0,mix(1.0,0.5,ANVIL_BIAS),anvilHeight*s.tower);
      float shapedCoverage=pow(max(s.coverage,1e-4),anvilExponent);
      float dimensionalProfile=clamp(s.profile*shapedCoverage,0.0,1.0);
      float d0=smoothstep(1.0-dimensionalProfile,1.0-dimensionalProfile+shapeWidth,s.baseNoise);
      envelope=dimensionalProfile;
    #else
      float threshold=COVERAGE-(weather.rawCoverage-0.5)*0.25-s.tower*0.18
        -s.tower*ANVIL_SPREAD*smoothstep(0.62,0.9,s.height);
      float d0=smoothstep(threshold,threshold+shapeWidth,s.baseNoise)*s.profile;
    #endif
    float d1=d0;
    if (erode && d0>0.0) {
      // Carve with the billowy detail itself through the lower ~40% (wispy
      // shredded bottoms) and with its inverse above (round billowy tops).
      // Capped at 0.55: tops keep just over half billow-preservation, so
      // domes still read as domes but their crests shred instead of staying
      // perfect spheres.
      float hfm=mix(s.detailNoise,1.0-s.detailNoise,clamp(s.height*1.6,0.0,0.55));
      // Partial-depth floor lets erosion bite into near-saturated samples
      // too; pure (1-d0) only shaves a thin skin, which reads cotton-ball.
      float e=EROSION*detailFade*hfm*(1.0-d0*0.65);
      d1=clamp(cloudRemap(d0,e,1.0,0.0,1.0),0.0,1.0);
    }
    d1=pow(d1,DENSITY_SHAPE);
    s.density=d1*mix(CUMULUS_GAIN,TOWER_GAIN,s.tower);
    return s;
  }
  CloudSample sampleCloudDensity(vec3 p, const int octaves, const bool erode) {
    return sampleCloudDensityLod(p, octaves, erode, 1.0);
  }
  float coarseCloudDensity(vec3 p) { return sampleCloudDensity(p,2,false).density; }
`;

// High-altitude cirrus as a 2.5-D scrolling layer (HZD/RDR2-style): one
// analytic plane intersection and one 2D density lookup instead of a march.
// View-shader-only — kept out of CLOUD_DENSITY_GLSL so the shadow map and
// light march never see it. Injected after the view shader's hgPhase/desat
// helpers, which it uses for the single-sample ice-crystal lighting.
export const CLOUD_CIRRUS_GLSL = /* glsl */ `
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
`;
