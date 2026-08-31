// One density implementation is injected into the view and shadow shaders.
// Callers provide the geometry/shape defines and the uniforms declared here.
export const CLOUD_DENSITY_GLSL = /* glsl */ `
  uniform float uTime;
  uniform sampler3D tCloudBaseNoise;
  uniform sampler3D tCloudDetailNoise;

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
    float nC = cloudVnoise(vec3(w, 3.7))*0.65
             + cloudVnoise(vec3(w*2.3+11.0, 9.1))*0.35;
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

  vec3 cloudNoiseCoordinates(vec3 p, float tower, out vec3 detailQ) {
    vec3 q = p * NOISE_SCALE;
    vec2 wind = uTime * WIND_SPEED * WIND_DIR;
    detailQ = (q + vec3(wind.x,0.0,wind.y))*EROSION_SCALE;
    q.xz *= mix(0.7,0.45,tower);
    q.y *= mix(1.0,0.7,tower);
    q.xz += wind;
    float warp = cloudVnoise(q*0.5 + vec3(0.0,uTime*0.015,0.0));
    q += (warp-0.5)*0.9;
    return q;
  }

  float cloudBaseSignal(vec3 q, const int octaves, const bool detailed) {
    #ifdef CLOUD_NOISE_TEXTURE
      vec4 b0 = texture(tCloudBaseNoise, q*0.18);
      // Both coarse and fine density use R as the same occupancy envelope.
      // Fine-only GBA and the second decorrelated read enter erosion below,
      // never the occupied-region test.
      return b0.r;
    #else
      return cloudFbm(q, octaves);
    #endif
  }
  float cloudDetailSignal(vec3 q) {
    #ifdef CLOUD_NOISE_TEXTURE
      vec3 d = texture(tCloudDetailNoise, q*0.25).rgb;
      return dot(d, vec3(0.55,0.30,0.15));
    #else
      return cloudWorleyFbm(q);
    #endif
  }

  CloudSample sampleCloudDensity(vec3 p, const int octaves, const bool erode) {
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
    vec3 q=cloudNoiseCoordinates(vec3(shearedXZ.x,p.y,shearedXZ.y),s.tower,detailQ);
    s.baseNoise=cloudBaseSignal(q,octaves,erode);
    s.detailNoise=0.0;
    if (erode) {
      s.detailNoise=cloudDetailSignal(detailQ);
      #ifdef CLOUD_NOISE_TEXTURE
        vec4 baseDetail=texture(tCloudBaseNoise,q*0.18);
        vec4 baseDetail2=texture(tCloudBaseNoise,q.zyx*0.127+vec3(0.37,0.11,0.73));
        float packedWorley=dot(baseDetail.gba,vec3(0.55,0.30,0.15));
        s.detailNoise=mix(s.detailNoise,packedWorley*0.75+baseDetail2.r*0.25,0.28);
      #endif
    }
    #ifdef CLOUD_PROFILE_DIMENSIONAL
      float anvilHeight=smoothstep(0.70,0.80,s.height);
      float anvilExponent=mix(1.0,mix(1.0,0.5,ANVIL_BIAS),anvilHeight*s.tower);
      float shapedCoverage=pow(max(s.coverage,1e-4),anvilExponent);
      float dimensionalProfile=clamp(s.profile*shapedCoverage,0.0,1.0);
      float d0=smoothstep(1.0-dimensionalProfile,1.0-dimensionalProfile+SHAPE_WIDTH,s.baseNoise);
    #else
      float threshold=COVERAGE-(weather.rawCoverage-0.5)*0.25-s.tower*0.18
        -s.tower*ANVIL_SPREAD*smoothstep(0.62,0.9,s.height);
      float d0=smoothstep(threshold,threshold+SHAPE_WIDTH,s.baseNoise)*s.profile;
    #endif
    float d1=d0;
    if (erode && d0>0.0 && d0<1.0) {
      float e=EROSION*(1.0-s.detailNoise)*(1.0-d0);
      d1=clamp(cloudRemap(d0,e,1.0,0.0,1.0),0.0,1.0);
    }
    s.density=d1*mix(CUMULUS_GAIN,TOWER_GAIN,s.tower);
    return s;
  }
  float coarseCloudDensity(vec3 p) { return sampleCloudDensity(p,2,false).density; }
`;
