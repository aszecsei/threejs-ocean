// The sea surface seen from underneath.
//
// Above the water the surface is dominated by what it reflects; below it, by
// Snell's window -- refraction compresses the entire 180-degree sky into a
// 97-degree cone overhead, and outside that cone the surface is a mirror,
// because a ray steeper than the critical angle cannot leave the water at all.
//
// Included by ocean.main.glsl after scatter.glsl (for the medium) and
// skyColor() (for the fallback), so it can use both.

  // Far enough that the water column has extinguished everything; stands in
  // for an unbounded look into the volume.
  const float UNDERSIDE_FAR = 4000.0;

  // How much a channel's refractive index is pulled either side of the mean.
  // Real dispersion in water across the visible band is about a third of this;
  // the exaggeration is what makes the window's rim read as heavy refraction
  // rather than as a soft edge.
  const float UNDERSIDE_DISPERSION = 0.012;

  /**
   * Radiance leaving the underside of the surface toward the camera. The
   * water column between here and the eye is *not* applied -- the underwater
   * resolve pass owns that, for this surface and for everything else in the
   * frame alike.
   *
   * `N` is the surface normal, pointing up; `viewDir` runs from the eye to
   * the surface, so underwater it points upward too.
   */
  vec3 oceanUnderside(vec3 N, vec3 viewDir, float foamAmount) {
    // Incident side is the water, so the interface normal points down at the
    // eye, and the ratio is n_water / n_air.
    vec3 Nw = -N;

    // What the eye would see looking back down into the volume: the same
    // multiple-scattering term the resolve pass uses, along the mirrored ray.
    // This is both the total-internal-reflection colour and the Fresnel
    // reflection blended in inside the window.
    vec3 Rw = reflect(viewDir, Nw);
    vec3 mirrored = waterMultiScatter(0.0, Rw.y, UNDERSIDE_FAR);

    vec3 T = refract(viewDir, Nw, uWaterIor);
    // refract() returns exactly zero past the critical angle: no ray leaves
    // the water, and the surface is a perfect mirror.
    if (dot(T, T) < 1e-6) return mirrored;

    // Inside the window. The sky and clouds were drawn into the capture
    // buffer, so the refracted ray can read the real thing and fall back to
    // the procedural sky only where the screen holds nothing.
    vec3 sky = skyColor(T, uSunDirection, uZenithColor, uHorizonColor, uGroundColor, uSunColor);
    vec3 refracted = sampleDirection(vWorldPos, T, sky);

    #ifdef OCEAN_DISPERSION
      // Red bends least, blue most. Splitting the index per channel smears
      // the rim of the window into a spectrum, which is the single strongest
      // cue that you are looking through water rather than at a texture.
      vec3 Tr = refract(viewDir, Nw, uWaterIor * (1.0 - UNDERSIDE_DISPERSION));
      vec3 Tb = refract(viewDir, Nw, uWaterIor * (1.0 + UNDERSIDE_DISPERSION));
      // Either edge can fall outside the window while the mean ray is inside;
      // that channel is mirrored instead, which is what tints the rim.
      float r = dot(Tr, Tr) < 1e-6
        ? mirrored.r
        : sampleDirection(vWorldPos, Tr, skyColor(Tr, uSunDirection, uZenithColor, uHorizonColor, uGroundColor, uSunColor)).r;
      float b = dot(Tb, Tb) < 1e-6
        ? mirrored.b
        : sampleDirection(vWorldPos, Tb, skyColor(Tb, uSunDirection, uZenithColor, uHorizonColor, uGroundColor, uSunColor)).b;
      refracted = vec3(r, refracted.g, b);
    #endif

    // Fresnel measured in the *air* side. As the view approaches the critical
    // angle the transmitted ray goes grazing, cos falls to zero and this
    // ramps to 1 on its own -- so the window's edge and the mirror outside it
    // meet continuously, with no threshold to tune.
    float cosT = abs(dot(T, N));
    float fresnel = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);

    vec3 col = mix(refracted, mirrored, fresnel);

    // Foam from below is a dense cloud of bubbles: it scatters rather than
    // transmits, so it veils the window instead of brightening it.
    return mix(col, waterDownwelling(0.0) * 0.12, foamAmount * 0.7);
  }
