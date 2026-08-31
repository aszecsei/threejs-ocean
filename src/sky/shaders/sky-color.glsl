// The sky as a function: skyPhysical() and skyColor().
//
// The numeric constants are NOT written here. They are generated from
// SKY_CONSTS in sky.ts and prepended to this chunk, because the CPU mirror
// (skyPhysicalJS) reads the same object -- that shared source is the only
// thing keeping the GPU and CPU sky in agreement.

  const float PI = 3.141592653589793;

  // Physical single-scattering sky, tonemapped. halo scales the art glow;
  // disk returns the sun-disk mask for the caller.
  vec3 skyPhysical(vec3 dir, vec3 sunDir, vec3 sunCol, float halo, out float disk) {
    // --- Scattering coefficients (depend on sun only) ---
    float sunE = SUN_EE * max(0.0, 1.0 - exp(-((SUN_CUTOFF - acos(clamp(sunDir.y, -1.0, 1.0))) / SUN_STEEPNESS)));
    float sunFade = 1.0 - clamp(1.0 - exp(sunDir.y), 0.0, 1.0);
    vec3 betaR = RAYLEIGH_TOTAL * RAYLEIGH;
    float mieC = 0.2 * TURBIDITY * 10.0e-18;
    vec3 betaM = 0.434 * mieC * MIE_CONST * MIE_COEFFICIENT;

    // --- Optical depth along the view ray (analytic, clamped at horizon) ---
    float cosZ = max(dir.y, 0.0);
    float zenithAngle = acos(cosZ);
    float inv = 1.0 / (cosZ + 0.15 * pow(93.885 - degrees(zenithAngle), -1.253));
    vec3 Fex = exp(-(betaR * (RAYLEIGH_ZENITH_LENGTH * inv) + betaM * (MIE_ZENITH_LENGTH * inv)));

    // --- In-scattered light ---
    float mu = dot(dir, sunDir);
    float rPhase = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
    float g2 = MIE_G * MIE_G;
    float mPhase = (1.0 / (4.0 * PI)) * (1.0 - g2) / pow(1.0 - 2.0 * MIE_G * mu + g2, 1.5);
    vec3 ratio = (betaR * rPhase + betaM * mPhase) / (betaR + betaM);
    vec3 Lin = pow(sunE * ratio * (1.0 - Fex), vec3(1.5));
    Lin *= mix(vec3(1.0), pow(sunE * ratio * Fex, vec3(0.5)),
               clamp(pow(1.0 - sunDir.y, 5.0), 0.0, 1.0));

    // --- Sun disk + faint space term ---
    disk = smoothstep(SUN_ANGULAR_DIAMETER_COS, SUN_ANGULAR_DIAMETER_COS + 0.00002, mu);
    vec3 L0 = vec3(0.1) * Fex + sunE * 19000.0 * Fex * disk;

    vec3 hdr = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
    hdr = pow(hdr, vec3(1.0 / (1.2 + 1.2 * sunFade)));

    // Soft wide halo in the sun's tint (art term; the Mie lobe alone is tight).
    hdr += sunCol * halo * pow(max(mu, 0.0), 24.0) * Fex;

    // --- Tonemap ---
    return 1.0 - exp(-hdr * EXPOSURE);
  }

  #ifdef SKY_GRADE_LUT
  // Baked art-grade multiplier (createGradeLUT): the whole reference-sky
  // evaluation below is a pure function of dir.y once sun and palette are
  // fixed (page load), so one LUT tap replaces a full skyPhysical call.
  // Must be bound by every consumer of this GLSL when SKY_GRADE_LUT is
  // defined (share the sky's uniform object, like the color uniforms).
  uniform sampler2D uGradeLUT;
  #endif

  vec3 skyColor(vec3 dir, vec3 sunDir, vec3 zenith, vec3 horizon, vec3 ground, vec3 sunCol) {
    float disk;
    vec3 col = skyPhysical(dir, sunDir, sunCol, HALO, disk);

    // --- Art grade, anchored to the reference sun ---
    float cosZ = max(dir.y, 0.0);
    #ifdef SKY_GRADE_LUT
    // X axis is pow(cosZ, 0.55) -- same warp as the target gradient, so
    // texels crowd the horizon where the reference sky changes fastest.
    col *= texture2D(uGradeLUT,
                     vec2(pow(cosZ, 0.55) * GRADE_LUT_SCALE
                          + GRADE_LUT_OFFSET, 0.5)).rgb;
    #else
    float refDisk;
    vec3 refDir = REF_PERP * sqrt(max(1.0 - cosZ * cosZ, 0.0)) + vec3(0.0, cosZ, 0.0);
    vec3 ref = skyPhysical(refDir, REF_SUN, sunCol, 0.0, refDisk);
    vec3 target = mix(horizon, zenith, pow(cosZ, 0.55));
    // The anchor fades out as the sun drops so sunsets go fully physical
    // (the palette is a mid-afternoon look; it would cancel the warming).
    float gradeAmt = GRADE * smoothstep(0.05, 0.35, sunDir.y);
    col *= pow(target / max(ref, vec3(1e-3)), vec3(gradeAmt));
    #endif
    col = mix(vec3(dot(col, LUMA)), col, SATURATION);

    // HDR sun disc: well above the bloom threshold (post.js) so it blooms
    // into a soft glow; ACES rolls it off to white.
    col = mix(col, sunCol * 6.0, disk);

    // Below the horizon: fade to the ground/sea fill.
    col = mix(col, ground, smoothstep(0.0, 0.25, -dir.y));
    return col;
  }
