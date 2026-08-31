// Ocean surface shading: SSR, foam, detail normals, cloud shadow and the
// final BRDF. skyColor() is injected ahead of this file (see SKY_COLOR_GLSL).
  #include <packing>

  // The medium under the surface. The include is unconditional (it is
  // resolved before the preprocessor runs) but everything in it compiles away
  // with UNDERWATER, so the above-water shader is unchanged.
  #ifdef UNDERWATER
  #include "../underwater/shaders/scatter.glsl";
  #endif

  // --- Screen-space reflection helpers ------------------------------------
  // Project a world point to screen uv; also returns view-space z (negative
  // in front of the camera) and whether the point is in front of the camera.
  vec2 ssrProject(vec3 p, out float viewZ, out bool ok) {
    vec4 vp = viewMatrix * vec4(p, 1.0);
    vec4 cp = uProjection * vp;
    viewZ = vp.z;
    ok = cp.w > 1e-4;
    return (cp.xy / max(cp.w, 1e-4)) * 0.5 + 0.5;
  }

  bool ssrOnScreen(vec2 uv) {
    return uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0;
  }

  float ssrEdgeFade(vec2 uv) {
    vec2 f = smoothstep(0.0, uSsrEdgeFade, uv) * smoothstep(1.0, 1.0 - uSsrEdgeFade, uv);
    return f.x * f.y;
  }

  // Ray at world point p vs. the captured depth buffer: true when the ray
  // has gone just behind the stored surface (within thickness).
  bool ssrTest(vec3 p, out vec2 uv) {
    float vz; bool ok;
    uv = ssrProject(p, vz, ok);
    if (!ok || !ssrOnScreen(uv)) return false;
    float d = texture2D(uSceneDepth, uv).r;
    if (d >= 0.99999) return false; // sky: nothing to hit
    float sz = perspectiveDepthToViewZ(d, uCameraNear, uCameraFar);
    return vz < sz && vz > sz - uSsrThickness;
  }

  // Radiance arriving from a direction, for content that has no parallax:
  // if the direction lands on screen where the capture drew sky (and clouds),
  // that pixel is exact. Used both as the SSR miss path and, underwater, as
  // the refracted lookup through Snell's window.
  vec3 sampleDirection(vec3 origin, vec3 dir, vec3 fallback) {
    float vz; bool ok;
    vec2 uv = ssrProject(origin + dir * 2000.0, vz, ok);
    if (ok && ssrOnScreen(uv) && texture2D(uSceneDepth, uv).r >= 0.99999) {
      return mix(fallback, texture2D(uSceneColor, uv).rgb, ssrEdgeFade(uv));
    }
    return fallback;
  }

  // Reflected radiance along R from world point origin. Falls back to the
  // procedural sky wherever the screen holds no information.
  vec3 ssrReflect(vec3 origin, vec3 R, vec3 fallback) {
    float t = 0.0;
    float stepLen = SSR_STEP0;
    float tPrev = 0.0;
    vec2 uv = vec2(0.0);
    bool hit = false;

    #ifdef SSR_BOUNDS_GATE
    // The capture depth holds only the knot: skip the whole march when the
    // reflected ray cannot intersect its bounding sphere (conservative
    // superset test -- rays that could hit still march). Grazing horizon
    // rays otherwise burn all SSR_STEPS on-screen and miss anyway; the
    // direction fallback below is exact for the sky/cloud content they
    // would have found.
    vec3 oc = origin - uReflectBound.xyz;
    float ob = dot(oc, R);
    float oc2 = dot(oc, oc) - uReflectBound.w * uReflectBound.w;
    bool mayHit = (ob * ob - oc2 > 0.0) && (ob < 0.0 || oc2 < 0.0);
    #else
    bool mayHit = true;
    #endif

    if (mayHit)
    for (int i = 0; i < SSR_STEPS; i++) {
      tPrev = t;
      t += stepLen;
      stepLen *= SSR_STEP_GROWTH;
      vec3 p = origin + R * t;
      float vz; bool ok;
      vec2 puv = ssrProject(p, vz, ok);
      if (!ok || !ssrOnScreen(puv)) break;
      if (ssrTest(p, uv)) { hit = true; break; }
    }

    if (hit) {
      // Binary refinement between the last miss and the hit.
      float lo = tPrev;
      float hi = t;
      for (int i = 0; i < SSR_REFINE; i++) {
        float mid = 0.5 * (lo + hi);
        vec2 muv;
        if (ssrTest(origin + R * mid, muv)) { hi = mid; uv = muv; } else { lo = mid; }
      }
      return mix(fallback, texture2D(uSceneColor, uv).rgb, ssrEdgeFade(uv));
    }

    // No geometry hit: fall through to the direction-only lookup.
    return sampleDirection(origin, R, fallback);
  }

  // Bicubic (B-spline) sample of the foam texture via 4 bilinear taps.
  // The FFT foam is accumulated per texel (~0.8 m); plain bilinear reads
  // leave fading patches as translucent slabs with straight texel edges,
  // which read as "mesh edges" up close. The cubic kernel removes the
  // plateaus without an extra blur pass.
  vec4 sampleFoamCubic(sampler2D tex, float size, vec2 uv) {
    vec2 texSize = vec2(size);
    vec2 p = uv * texSize - 0.5;
    vec2 f = fract(p);
    p -= f;
    vec2 f2 = f * f;
    vec2 f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 s0 = w0 + w1;
    vec2 s1 = w2 + w3;
    vec2 o0 = w1 / s0 - 1.0;
    vec2 o1 = w3 / s1 + 1.0;
    vec2 uv0 = (p + 0.5 + o0) / texSize;
    vec2 uv1 = (p + 0.5 + o1) / texSize;
    vec4 a = texture2D(tex, vec2(uv0.x, uv0.y));
    vec4 b = texture2D(tex, vec2(uv1.x, uv0.y));
    vec4 c = texture2D(tex, vec2(uv0.x, uv1.y));
    vec4 d = texture2D(tex, vec2(uv1.x, uv1.y));
    return (a * s0.x + b * s1.x) * s0.y + (c * s0.x + d * s1.x) * s1.y;
  }

  // Decode the tangent-space xy of the baked normal map (-1..1).
  vec2 detailNormalXY(vec2 uv) {
    return texture2D(uDetailTex, uv).rg * 2.0 - 1.0;
  }

  float cloudDirectTransmittance(vec3 worldPosition) {
    #ifdef CLOUD_SHADOWS
      vec2 uv = (worldPosition.xz - uCloudShadowCenter) / uCloudShadowExtent + 0.5;
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
      return mix(1.0, texture2D(tCloudShadow, uv).r, inside * uCloudShadowEnabled);
    #else
      return 1.0;
    #endif
  }

  // Needs sampleDirection() and skyColor(), so it lands here rather than
  // beside the other helpers.
  #ifdef UNDERWATER
  #include "./ocean.underside.glsl";
  #endif

  float ggx(vec3 n, vec3 v, vec3 l, float rough) {
    vec3 hv = normalize(v + l);
    float a = max(rough * rough, 1e-4);
    float a2 = a * a;
    float ndh = max(dot(n, hv), 0.0);
    float d = ndh * ndh * (a2 - 1.0) + 1.0;
    return a2 / (3.14159265 * d * d);
  }

  void main() {
    vec3 viewDir = normalize(vWorldPos - cameraPosition);

    // Past uFogFar the fog mix below lands on the sky color exactly, so the
    // outermost rings -- horizon micro-triangles with worst-case quad
    // overshading -- skip the whole water shader. Seamless by construction.
    // Underwater the same rings are past several hundred metres of water, so
    // the resolve pass multiplies them by ~0 and replaces them with the
    // volume; black is exactly what it wants to receive.
    if (vDist > uFogFar) {
      #ifdef UNDERWATER
        vec3 farColor = gl_FrontFacing
          ? skyColor(viewDir, uSunDirection, uZenithColor, uHorizonColor, uGroundColor, uSunColor)
          : vec3(0.0);
      #else
        vec3 farColor = skyColor(viewDir, uSunDirection, uZenithColor, uHorizonColor, uGroundColor, uSunColor);
      #endif
      gl_FragColor = vec4(farColor, 1.0);
      #ifdef TAA_ENABLED
        taaMotion = taaPackMotion(vTaaCurrentClip, vTaaPreviousClip, 0.0);
      #endif
      return;
    }

    // Foam texture packs: x = accumulated foam, yzw = smooth water normal.
    vec4 F = sampleFoamCubic(uFoam, uFoamSize, vUv);
    vec3 N = normalize(F.yzw);
    float fftFoam = F.x;

    #ifdef OCEAN_CASCADE2
    // Beyond the fade the whole block is multiplied by exactly 0, so the 4
    // bicubic taps can be skipped (the fade is per-vertex, so the branch is
    // coherent across the far field).
    if (vFade2 > 0.001) {
      // Normals compose as slopes, not as vectors: recover (dh/dx, dh/dz)
      // from each unit normal, add them, rebuild. Averaging the normals
      // instead would flatten the total slope wherever they disagree.
      vec4 F2 = sampleFoamCubic(uFoam2, uFoamSize2, vUv2);
      vec3 N2 = normalize(F2.yzw);
      vec2 slope = -N.xz / max(N.y, 1e-3) - (N2.xz / max(N2.y, 1e-3)) * vFade2;
      N = normalize(vec3(-slope.x, 1.0, -slope.y));
      // Same max() convention foamRaw already uses for FFT vs contact foam.
      fftFoam = max(fftFoam, F2.x * vFade2);
    }
    #endif

    vec3 V = -viewDir;
    vec3 L = normalize(uSunDirection);
    // The shadow map modulates direct sun only. Sky reflection, the deep
    // ambient term and foam lift remain visible below clouds.
    float cloudShadow = cloudDirectTransmittance(vWorldPos);

    // Foam churn/bubbles: two slowly drifting samples of the lace texture.
    // Sampled before the normals so foam can flatten the ripple detail.
    vec2 dp = vWorldPos.xz;
    #ifdef OCEAN_DETAIL
    // Macro layer (large tile, slow pan): shared by the foam and the ripple
    // normals below. Breaks up tiling by domain-warping the finer lookups.
    vec2 nM = detailNormalXY((dp - uTime * uDetailMacroPan) * uDetailMacro.x);
    vec2 fwarp = nM * uFoamMacroWarp;
    // A second, even larger macro read gates the foam so lace density varies
    // across the sea instead of repeating with the churn tile.
    float foamGate = texture2D(uDetailTex, (dp.yx + uTime * vec2(0.03, 0.02)) * uDetailMacro.x * 0.55).b;
    vec2 cuvA = (dp + fwarp) * uFoamChurnScale + uTime * vec2(0.012, -0.02);
    vec2 cuvB = (dp - fwarp.yx) * uFoamChurnScale * 0.37 + uTime * vec2(-0.008, 0.006);
    vec4 churnA = texture2D(uDetailTex, cuvA);
    vec4 churnB = texture2D(uDetailTex, cuvB);
    float churn = clamp(0.65 * churnA.b + 0.45 * churnB.b, 0.0, 1.0);
    churn = clamp(churn * (0.55 + 0.9 * foamGate), 0.0, 1.0);
    float bubbles = churnA.a;
    #else
    // ?detail=0: skip the detail taps entirely (not just their strength)
    // so the A/B measures their real cost. Neutral mid values keep the
    // contact-foam erosion below usable.
    float churn = 0.5;
    float bubbles = 0.5;
    #endif

    // Foam mask: an erosion threshold through the churn pattern. Fresh foam
    // (F.x near 1) is solid; as the accumulated foam decays only the bright
    // lace filaments survive, so patches tear apart instead of fading as a
    // blob, and the 256^2 texel steps of F.x are broken up.
    #ifdef OCEAN_DETAIL
      float foamMask = smoothstep(0.0, uFoamEdge, fftFoam * 1.1 - (1.0 - churn) * 0.5);
      // Translucent, and thinner as the foam ages: coverage tracks the
      // accumulated value so patches dissolve gradually instead of cutting off.
      foamMask *= (0.6 + 0.4 * churn) * uFoamOpacity * smoothstep(0.0, 0.9, fftFoam);
    #else
      float foamMask = smoothstep(0.3, 0.8, fftFoam);
    #endif

    // --- Contact foam: water meeting captured geometry ------------------
    // View-space depth gap between this water fragment and whatever the
    // capture pass drew behind it (the knot). Water hidden by the knot is
    // depth-rejected, so only the visible skirt gets foam. The gap is a
    // slant range, not a water-column depth, so the skirt widens a little
    // at grazing angles (width is narrowed when looking down to compensate).
    float contact = 0.0;
    float contactFoam = 0.0;
    float gap = 1e3;
    if (uContact.y > 0.0 && vDist < 60.0) {
      vec2 suv = gl_FragCoord.xy * uInvResolution;
      float sd = texture2D(uSceneDepth, suv).r;
      if (sd < 0.99999) { // not sky
        float sceneZ = perspectiveDepthToViewZ(sd, uCameraNear, uCameraFar);
        float waterZ = (viewMatrix * vec4(vWorldPos, 1.0)).z;
        gap = max(waterZ - sceneZ, 0.0); // both negative; scene farther => positive
        float width = uContact.x * (0.6 + 0.4 * max(-viewDir.y, 0.0));
        contact = 1.0 - smoothstep(0.0, width, gap);
        // Slow breathing so the skirt reads as churn, not a static decal.
        contact *= 1.0 - uContact.w + uContact.w * (0.5 + 0.5 * sin(uTime * 2.6 + gap * 18.0 + churn * 6.0));
        // Erode through the churn lace like the FFT foam so it tears.
        contactFoam = smoothstep(0.0, uFoamEdge, contact * 1.3 - (1.0 - churn) * 0.5);
        contactFoam *= (0.6 + 0.4 * churn) * uContact.y;
      }
    }
    // foamRaw drives roughness / specular kill / detail damping;
    // foamAmount is the visible foam coverage.
    float foamRaw = max(fftFoam, contact);
    float foamAmount = max(foamMask, contactFoam);

    // Ripple detail normals: the baked normal map at two scales, each
    // panning at its own world-space velocity (a static normal on moving
    // water reads as a decal), summed and tilted into world XZ. The mip chain keeps the far
    // field clean, so only a gentle fade guards the horizon roughness.
    //
    // The macro layer domain-warps both lookups so their tiling never lines
    // up. The offset is in *cycles of each layer's own tiling*, not world
    // units: a fixed world offset shifts the 1.8 cyc/m layer four times
    // further in phase than the 0.45 one, which shears the fine layer into
    // filaments and reads as marbled oil rather than water.
    #ifdef OCEAN_DETAIL
    vec2 warp = nM * uDetailMacro.z;
    vec2 nA = detailNormalXY((dp - uTime * uDetailPan.xy) * uDetailScale.x + warp);
    vec2 nB = detailNormalXY((dp - uTime * uDetailPan.zw) * uDetailScale.y - warp.yx);
    // The macro map also modulates fine amplitude so ripple density varies
    // in patches instead of being uniform everywhere. Shallow on purpose:
    // deep modulation carves the surface into slick-looking patches.
    float patchAmp = 0.85 + 0.3 * nM.x;
    vec2 nD = (nA + nB * 0.7) * patchAmp + nM * uDetailMacro.y;
    float detailAmp = uDetailStrength * exp(-vDist * 0.01) * (1.0 - 0.7 * foamRaw);
    // Inside foam, tilt along the churn pattern instead so foam reads as a
    // churned surface catching the sun rather than a flat decal.
    vec2 nF = detailNormalXY(cuvA);
    // Ring ripples radiating from the contact line.
    nD += nF * uContact.z * contact * sin(gap * 30.0 - uTime * 4.0);
    nD = mix(nD * detailAmp, nF * uFoamBump * uDetailStrength, foamAmount);
    N = normalize(N + vec3(nD.x, 0.0, nD.y));
    #endif

    #ifdef UNDERWATER
    // From below, the surface model changes entirely: Snell's window and
    // total internal reflection replace the sky reflection and the deep-water
    // body. A back face is by definition a water -> air crossing, so this is
    // the right test whether or not the camera is submerged.
    if (!gl_FrontFacing) {
      gl_FragColor = vec4(oceanUnderside(N, viewDir, foamAmount), 1.0);
      #ifdef TAA_ENABLED
        // The window shimmers hard as the surface tilts, and its content has
        // no motion vector of its own, so shorten the history rather than
        // smearing the refraction.
        taaMotion = taaPackMotion(vTaaCurrentClip, vTaaPreviousClip, 0.25);
      #endif
      return;
    }
    #endif

    float NdV = max(dot(N, V), 0.0);

    // Fresnel (Schlick, water F0).
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);

    // Procedural sky reflection: same gradient function as the sky dome, so
    // reflection and dome can never drift apart.
    vec3 R = reflect(viewDir, N);
    R.y = abs(R.y) + 0.02; // never reflect from below the horizon
    R = normalize(R);
    vec3 skyRef = skyColor(R, uSunDirection, uZenithColor, uHorizonColor, uGroundColor, uSunColor);
    // Screen-space reflection of the captured scene (knot, clouds, sky),
    // falling back to the procedural sky off-screen. Faded with distance:
    // far water is fog-dominated and the march is wasted there.
    #ifndef SSR_DISABLED
    float ssrWeight = 1.0 - smoothstep(60.0, 140.0, vDist);
    if (ssrWeight > 0.001) {
      skyRef = mix(skyRef, ssrReflect(vWorldPos + N * 0.02, R, skyRef), ssrWeight);
    }
    #endif

    // --- Boosted sub-surface scattering --------------------------------
    // Light transmission through backlit crests (Barre-Brisebois): light
    // enters the far side of the crest along -L, is bent by the normal, and
    // exits toward the eye. So the eye vector V must align with the
    // *transmitted* direction -Lt, i.e. viewDir (eye -> surface) aligns
    // with +Lt. Biased by crest height, killed by Fresnel (only where not
    // mirroring).
    //
    // The sun sits well above the horizon, so the literal transmitted ray
    // -L points down into the water and an above-water eye can never line
    // up with it. Treat the crest as a thin vertical lens instead: take the
    // backlight from the sun's horizontal bearing (elevation only scales
    // it), which is the usual trick for water SSS.
    vec3 Lh = normalize(vec3(L.x, 0.0, L.z));
    vec3 Lt = normalize(Lh + N * uSSSDistort);
    float through = pow(max(dot(viewDir, Lt), 0.0), uSSSPower);
    float crest = smoothstep(-0.25, 0.9, vHeight);
    float sss = through * crest * (1.0 - fres) * uSSSStrength;

    // --- Composite -------------------------------------------------------
    float ndl = max(dot(N, L), 0.0);
    vec3 col = uDeepColor * (0.45 + 0.55 * ndl * cloudShadow);
    // Through-light is mostly direct, but retaining a small floor avoids a
    // hard cut in translucent crests at shadow-map texel boundaries.
    col += uSSSColor * sss * mix(0.25, 1.0, cloudShadow);
    col += skyRef * fres;

    // Dual-lobe sun specular: sharp glitter + broad sheen.
    float rough = mix(uRoughness, 0.45, foamRaw * 0.8);
    float spec = ggx(N, V, L, rough) + 0.18 * ggx(N, V, L, rough + 0.32);
    col += uSunColor * spec * ndl * cloudShadow * 0.16 * (1.0 - foamRaw);

    // Foam: warm-white, kills specular, soaks up SSS.
    vec3 foamCol = mix(vec3(0.97, 0.98, 1.0), uSunColor, 0.2) * (0.82 + 0.2 * ndl);
    foamCol *= 0.78 + 0.22 * bubbles;
    col = mix(col, foamCol, foamAmount);

    // Distance fog into the exact sky color along this view ray -> the
    // horizon dissolves seamlessly into the sky dome. Near-field fragments
    // (vDist < uFogNear) skip the second skyColor evaluation entirely.
    float fog = smoothstep(uFogNear, uFogFar, vDist);
    if (fog > 0.001) {
      col = mix(col, skyColor(viewDir, uSunDirection, uZenithColor, uHorizonColor, uGroundColor, uSunColor), fog);
    }

    // Linear output: color space and tone mapping are applied once by the
    // post pipeline (post.js).
    gl_FragColor = vec4(col, 1.0);
    #ifdef TAA_ENABLED
      // Geometry motion handles the wave surface itself. Foam, contact churn,
      // and sharp changing glints are less predictable, so they shorten the
      // history rather than leaving bright trails.
      float taaReactive = clamp(foamAmount * 0.8 + contactFoam * 0.5
                              + smoothstep(0.4, 2.0, spec) * 0.35, 0.0, 1.0);
      taaMotion = taaPackMotion(vTaaCurrentClip, vTaaPreviousClip, taaReactive);
    #endif
  }
