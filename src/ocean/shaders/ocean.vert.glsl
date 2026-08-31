// Ocean surface vertex stage: samples the FFT displacement cascades, fades
// cascade 2 with distance, and reconstructs the previous-frame position for
// TAA motion vectors.

  uniform sampler2D uDisplace;
  uniform float uPatchSize;

  #ifdef TAA_ENABLED
    uniform sampler2D uPreviousDisplace;
    uniform mat4 uPreviousViewProjection;
    uniform vec3 uPreviousCameraPosition;
    varying vec4 vTaaCurrentClip;
    varying vec4 vTaaPreviousClip;
  #endif

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying float vDist;

  #ifdef OCEAN_CASCADE2
    uniform sampler2D uDisplace2;
    #ifdef TAA_ENABLED
      uniform sampler2D uPreviousDisplace2;
    #endif
    uniform float uPatchSize2;
    uniform vec2 uCascade2Fade;
    varying vec2 vUv2;
    varying float vFade2;
  #endif

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);

    // World-anchored sampling: the wave field tiles with period uPatchSize
    // and does not move with the camera-following mesh. The displacement
    // texture wraps, so uv > 1 is fine.
    vec2 base = wp.xz;
    float rad = distance(base, cameraPosition.xz);
    vec2 uv = base / uPatchSize;
    vec4 d = texture2D(uDisplace, uv);

    // Gerstner choppy displacement + height (already scaled by the combine
    // pass of the FFT pipeline). Horizontal displacement fades out with
    // distance: far rings are coarser than the wave length, and folding
    // undersampled choppy displacement makes overlapping triangle sheets.
    float fade = smoothstep(30.0, 140.0, rad);
    wp.xz += d.xz * (1.0 - fade * 0.85);
    // Height also eases out at grazing angles to soften far-field faceting.
    wp.y = d.y * (1.0 - 0.5 * smoothstep(120.0, 320.0, rad));

    #ifdef OCEAN_CASCADE2
      // The fine cascade is sub-texel on the disc past a few tens of metres
      // and would alias into a crawling grid, so it fades out well before
      // the coarse one does. Sampled on the *undisplaced* xz, like cascade 0.
      vec2 uv2 = base / uPatchSize2;
      float fade2 = 1.0 - smoothstep(uCascade2Fade.x, uCascade2Fade.y, rad);
      vec4 d2 = texture2D(uDisplace2, uv2);
      wp.xz += d2.xz * (1.0 - fade * 0.85) * fade2;
      wp.y += d2.y * fade2;
      vUv2 = uv2;
      vFade2 = fade2;
    #endif

    #ifdef TAA_ENABLED
      // Rebuild last frame's displaced surface at the same world-anchored
      // base point. Camera-following mesh recentering is not water motion.
      vec4 previousWp = vec4(base.x, 0.0, base.y, 1.0);
      float previousRad = distance(base, uPreviousCameraPosition.xz);
      vec4 previousD = texture2D(uPreviousDisplace, uv);
      float previousFade = smoothstep(30.0, 140.0, previousRad);
      previousWp.xz += previousD.xz * (1.0 - previousFade * 0.85);
      previousWp.y = previousD.y * (1.0 - 0.5 * smoothstep(120.0, 320.0, previousRad));
      #ifdef OCEAN_CASCADE2
        vec4 previousD2 = texture2D(uPreviousDisplace2, uv2);
        float previousFade2 = 1.0 - smoothstep(uCascade2Fade.x, uCascade2Fade.y, previousRad);
        previousWp.xz += previousD2.xz * (1.0 - previousFade * 0.85) * previousFade2;
        previousWp.y += previousD2.y * previousFade2;
      #endif
      vTaaPreviousClip = uPreviousViewProjection * previousWp;
    #endif

    vUv = uv;
    vWorldPos = wp.xyz;
    vHeight = d.y;
    vDist = distance(wp.xyz, cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * wp;
    #ifdef TAA_ENABLED
      vTaaCurrentClip = gl_Position;
    #endif
  }
