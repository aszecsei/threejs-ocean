// Seabed vertex stage: displaces the shared radial disc by the baked
// heightfield.
//
// Like the ocean, the mesh follows the camera in xz but the field is sampled
// world-anchored, so the sand stays put while the disc never runs out.

  #include "./seabed-height.glsl";

  #ifdef TAA_ENABLED
    uniform mat4 uPreviousViewProjection;
    varying vec4 vTaaCurrentClip;
    varying vec4 vTaaPreviousClip;
  #endif

  varying vec3 vWorldPos;
  varying vec2 vSandUv;
  varying float vDist;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec2 base = wp.xz;

    // Vertex-stage fetches have no derivatives, so seabedHeight reads the
    // base level by definition; the mip chain is for the fragment stage.
    wp.y = seabedHeight(base);

    vSandUv = base / uSeabedTile;
    vWorldPos = wp.xyz;
    vDist = distance(wp.xyz, cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * wp;

    #ifdef TAA_ENABLED
      // The sand does not move, and recentering the disc on the camera is not
      // motion either, so last frame's world position is this one's.
      vTaaCurrentClip = gl_Position;
      vTaaPreviousClip = uPreviousViewProjection * wp;
    #endif
  }
