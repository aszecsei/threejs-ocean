// Cloud density field: weather, shape and detail.
//
// One implementation, injected into both the view shader and the shadow-map
// shader. Callers provide the geometry/shape defines and the uniforms declared
// here, so this chunk must be injected after those declarations.
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
    // 1 at the thin outer shell of an edge, 0 inside the mass. Lighting uses
    // it to place the silver lining; always computed, wisps or not.
    float wispness;
  };

  vec3 cloudNoiseCoordinates(vec3 p, float tower, float height, out vec3 detailQ, out vec3 wispQ) {
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
    #ifdef CLOUD_WISP
      // Wisp domain: ~3x the finest erosion band, read from the same detail
      // volume (a smaller bake would give the same voxels per Worley cell,
      // so it buys nothing). Swizzled and offset so it does not correlate
      // with the bands it is drawn from; stronger curl and a fixed vertical
      // squash so it carves horizontal filaments rather than pebbles.
      wispQ = detailQ.zxy*WISP_SCALE + vec3(0.29,0.61,0.13) + curl*(CURL_STRENGTH*WISP_CURL);
      wispQ.y *= WISP_SQUASH;
    #else
      wispQ = detailQ;
    #endif
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
  // wispFade LODs the wisp band the same way; its cells are ~4 units across,
  // so it has to leave much earlier than the erosion does.
  CloudSample sampleCloudDensityLod(vec3 p, const int octaves, const bool erode, float detailFade, float wispFade) {
    CloudSample s = CloudSample(0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0);
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
    vec3 detailQ, wispQ;
    vec3 q=cloudNoiseCoordinates(vec3(shearedXZ.x,p.y,shearedXZ.y),s.tower,s.height,detailQ,wispQ);
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
    // The occupancy prepass samples on fixed coarse strata and must bound,
    // not estimate: it lowers every threshold by a margin so a clump that
    // only the jittered fine march would touch still registers here.
    #ifdef CLOUD_OCCUPANCY_MAP
      float thresholdMargin=OCCUPANCY_MARGIN;
    #else
      float thresholdMargin=0.0;
    #endif
    float envelope=1.0;
    #ifdef CLOUD_PROFILE_DIMENSIONAL
      float anvilHeight=smoothstep(0.70,0.80,s.height);
      float anvilExponent=mix(1.0,mix(1.0,0.5,ANVIL_BIAS),anvilHeight*s.tower);
      float shapedCoverage=pow(max(s.coverage,1e-4),anvilExponent);
      float dimensionalProfile=clamp(s.profile*shapedCoverage,0.0,1.0);
      float d0=smoothstep(1.0-dimensionalProfile-thresholdMargin,1.0-dimensionalProfile+shapeWidth,s.baseNoise);
      envelope=dimensionalProfile;
    #else
      float threshold=COVERAGE-(weather.rawCoverage-0.5)*0.25-s.tower*0.18
        -s.tower*ANVIL_SPREAD*smoothstep(0.62,0.9,s.height);
      float d0=smoothstep(threshold-thresholdMargin,threshold+shapeWidth,s.baseNoise)*s.profile;
    #endif
    // The thin shell is where all the high-frequency edge character lives;
    // interiors (d0 >= WISP_SHELL) and every coarse caller pay one smoothstep.
    float shell=1.0-smoothstep(0.0,WISP_SHELL,d0);
    #ifdef CLOUD_WISP
      if (erode && wispFade>0.0 && d0>0.0 && shell>0.0) {
        #ifdef CLOUD_NOISE_TEXTURE
          float wispN=dot(texture(tCloudDetailNoise,wispQ).rgb,vec3(0.25,0.35,0.40));
        #else
          float wispN=cloudWorleyFbm(wispQ*3.0);
        #endif
        // Perturbs the shape signal itself, ahead of the erosion, so the
        // wisp pattern decides where the erosion bites: high values survive
        // it as tendrils and detached crumbs, low values open gaps. A second
        // remap after the erosion cannot do this -- by then the erosion has
        // emptied most of the shell and there is nothing left to carve.
        // The gate on d0>0 keeps every addition inside the coarse envelope,
        // so the shadow map and the occupancy prepass still bound it.
        float k=WISP_STRENGTH*wispFade*shell;
        float delta=(wispN-0.45)*k;
        d0=clamp(d0+delta*(delta>0.0?WISP_PUFF:1.0),0.0,1.0);
      }
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
    // Thin after erosion as well as near the surface: what the rim term
    // should light is the translucent fringe, not a dense sliver.
    s.wispness=shell*(1.0-0.5*d1);
    d1=pow(d1,DENSITY_SHAPE);
    s.density=d1*mix(CUMULUS_GAIN,TOWER_GAIN,s.tower);
    return s;
  }
  CloudSample sampleCloudDensity(vec3 p, const int octaves, const bool erode) {
    return sampleCloudDensityLod(p, octaves, erode, 1.0, 1.0);
  }
  float coarseCloudDensity(vec3 p) { return sampleCloudDensity(p,2,false).density; }
