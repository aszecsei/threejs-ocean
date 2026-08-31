// Underwater resolve: grades the finished frame through the water body.
//
// Runs after the ocean has drawn, reading the frame it is about to replace
// plus the two things that say how much water each ray crossed: the capture
// depth (everything except the ocean) and the water mask (the ocean alone).
// The nearer of the two is where the water column ends.
//
// Deliberately does not need the frame's own depth buffer, which does not
// exist on the `?taa=0` path.

  #include <packing>

  uniform sampler2D tFrame;
  uniform sampler2D tSceneDepth;
  uniform sampler2D tMask;
  #ifdef TAA_ENABLED
  uniform sampler2D tFrameMotion;
  uniform sampler2D tFrameDepth;
  #endif

  uniform mat4 uInverseProjection;
  uniform mat4 uCameraWorld;
  uniform vec3 uCameraPosition;
  uniform float uCameraNear;
  uniform float uCameraFar;
  /** 1 when the camera itself is under the surface, from the CPU swell. */
  /** Camera height above the water surface, signed; negative when under. */
  uniform float uMeniscusHeight;

  varying vec2 vUv;

  #include "./scatter.glsl";
  #include "../../../taa/shaders/contract.glsl";

  // Everything past this is fully extinguished anyway; it stands in for an
  // unbounded water column so the closed form saturates rather than
  // overflowing.
  const float WATER_FAR = 4000.0;

  /**
   * Is the ray leaving this pixel travelling through water?
   *
   * A surface met from below puts the camera in the water on that ray, one
   * met from above puts it in the air. Where the ray misses the ocean
   * entirely the answer is still geometric rather than a guess: the disc
   * follows the camera out to 380 m, so from above the water every
   * downward ray lands on it, and a downward ray that misses can only mean
   * the surface is overhead. (The exception is the fraction of a degree
   * right at the horizon where a grazing ray outruns the disc -- which is
   * also where the ocean's own fog has already faded to sky.)
   */
  bool maskWet(vec4 m, float dirY) {
    return m.b > 0.5 ? m.r < 0.5 : dirY < 0.0;
  }

  #ifdef WATER_MENISCUS
  /**
   * Where the waterline crosses the lens, and how strongly.
   *
   * A pinhole camera has no waterline: it is above the surface or below it,
   * and the image flips between the two in one frame. A real housing has a
   * port of some width, and while the water is partway up it you see a band
   * where the surface passes through the glass. MENISCUS_PORT is that width.
   *
   * A ray leaving the camera at height `h` above the surface meets it at
   * distance h / -dir.y, so the rays that graze the rim of a port of radius R
   * are the ones with dir.y = -h / R. That is the band -- and it is a
   * closed form, needing only the camera's height above the water. As h goes
   * to zero the band converges on the horizon, which is exactly where the
   * waterline belongs at the moment of crossing; as |h| grows past R/2 it
   * leaves the frame on its own and the effect ends without a threshold.
   */
  float meniscusPort() {
    return -uMeniscusHeight / MENISCUS_PORT;
  }
  #endif

  void main() {
    vec3 frame = texture2D(tFrame, vUv).rgb;

    #ifdef TAA_ENABLED
      taaMotion = texture2D(tFrameMotion, vUv);
      gl_FragDepthEXT = texture2D(tFrameDepth, vUv).r;
    #endif

    // View ray for this pixel, in world space. The projection is the jittered
    // one the frame was drawn with, so the ray matches the depth beneath it.
    vec4 nearPoint = uInverseProjection * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
    vec3 viewDir = normalize(nearPoint.xyz / nearPoint.w);
    // Depth buffers store distance along the view axis, not along the ray.
    float slant = 1.0 / max(-viewDir.z, 1e-4);
    vec3 dir = normalize((uCameraWorld * vec4(viewDir, 0.0)).xyz);

    // How far the nearest non-ocean geometry is. Sky reads as unbounded.
    float rawDepth = texture2D(tSceneDepth, vUv).r;
    float sceneDist = rawDepth >= 0.99999
      ? WATER_FAR
      : -perspectiveDepthToViewZ(rawDepth, uCameraNear, uCameraFar) * slant;

    // The mask decides which side of the surface this ray starts on. A
    // back-facing nearest surface means the ray leaves the camera in water;
    // a front-facing one means it leaves in air. Where the ocean disc was
    // never drawn there is nothing to go on, so the CPU state stands in.
    vec4 mask = texture2D(tMask, vUv);
    bool hit = mask.b > 0.5;
    bool maskW = maskWet(mask, dir.y);
    bool wet = maskW;

    // The waterline on the port, as a ray direction (see meniscusPort).
    // Outside [-1, 1] the glass is entirely in one medium and the mask has
    // the whole answer.
    float port = 2.0;
    #ifdef WATER_MENISCUS
      port = meniscusPort();
      // Rays leaving the submerged part of the glass are in the water even
      // where a pinhole at the centre of it would have been in air. This is
      // what makes the crossing an over-under shot -- the lower half looking
      // away through the sea -- rather than a single frame where the whole
      // image flips.
      if (abs(port) < 1.0 && dir.y < port) wet = true;
    #endif

    #if UNDERWATER_DEBUG == 1
      // Red where the surface is seen from above, green from below, black
      // where the ocean disc was never drawn. The red/green seam is the
      // waterline the meniscus rides.
      gl_FragColor = vec4(hit ? mask.r : 0.0, hit ? 1.0 - mask.r : 0.0, 0.0, 1.0);
      return;
    #endif

    // The water column ends at whichever surface the ray reaches first: the
    // underside of the sea, or something floating in it. A ray that only the
    // port called wet entered below the waterline on the glass and is heading
    // down into the sea, so it never crosses back out -- the surface a
    // pinhole would have struck is not on its path.
    float s = min(hit && maskW ? mask.g : WATER_FAR, sceneDist);

    #if UNDERWATER_DEBUG == 2
      // Path length through water, banded every metre.
      float ring = fract(s);
      gl_FragColor = vec4(vec3(wet ? ring * exp(-s * 0.05) : 0.0), 1.0);
      return;
    #endif

    vec3 col = frame;
    if (wet) {
      col = frame * waterTransmittance(s);
      col += waterMultiScatter(uWaterCameraDepth, dir.y, s);

      #ifdef WATER_SHAFTS
        col += waterSingleScatter(uCameraPosition, dir, min(s, WATER_SHAFT_RANGE),
                                  waterShaftJitter(gl_FragCoord.xy));
      #endif
    }

    #ifdef WATER_MENISCUS
      // The film of water clinging to the port. It is a lens a millimetre
      // thick pressed against the glass, so it compresses both worlds into a
      // few pixels and scatters them: not something worth modelling
      // literally, but a vertically squashed read of the frame from either
      // side, lifted, lands in the right place.
      // Signed position across the band: -1 at its lower edge, +1 at its
      // upper one, 0 on the waterline itself.
      float d = abs(port) < 1.0 ? (dir.y - port) / MENISCUS_WIDTH : 2.0;
      if (abs(d) < 1.0) {
        vec3 above = texture2D(tFrame, vec2(vUv.x, vUv.y + MENISCUS_SMEAR)).rgb;
        vec3 below = texture2D(tFrame, vec2(vUv.x, vUv.y - MENISCUS_SMEAR)).rgb;
        // The film drags each side's content across the line, which is what
        // makes the band read as a lens rather than as a drawn stripe.
        vec3 smear = mix(below, above, clamp(0.5 + 0.35 * d, 0.0, 1.0));
        // A waterline on glass is a dark lip with a bright edge sitting just
        // above it, where the curve of the film catches the sky.
        float rim = 1.0 - smoothstep(0.0, 0.4, abs(d - 0.5));
        vec3 film = smear * (0.55 + MENISCUS_LIFT * rim);
        // Squared, so the band has a soft shoulder and a defined centre
        // instead of a uniform stripe with two hard edges.
        float band = 1.0 - abs(d);
        col = mix(col, film, band * band * MENISCUS_STRENGTH);
      }
    #endif

    gl_FragColor = vec4(col, 1.0);
  }
