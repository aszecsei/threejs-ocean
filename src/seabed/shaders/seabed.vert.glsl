// Seabed vertex stage: displaces the shared radial disc by the baked
// heightfield, at two tilings so the floor has dunes as well as ripples.
//
// Like the ocean, the mesh follows the camera in xz but the field is sampled
// world-anchored, so the sand stays put while the disc never runs out.

  uniform sampler2D uSeabedTex;
  uniform float uSeabedDepth;
  uniform float uSeabedTile;
  uniform float uSeabedRelief;
  uniform vec2 uSeabedMacro; // tiling multiplier, relief multiplier

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

    vec2 uv = base / uSeabedTile;
    vec2 uvMacro = base / (uSeabedTile * uSeabedMacro.x) + 0.37;
    // Vertex-stage fetches have no derivatives, so these are base-level reads
    // by definition; the mip chain is for the fragment stage.
    float h = texture2D(uSeabedTex, uv).a - 0.5;
    float hMacro = texture2D(uSeabedTex, uvMacro).a - 0.5;
    wp.y = -uSeabedDepth + h * uSeabedRelief + hMacro * uSeabedRelief * uSeabedMacro.y;

    vSandUv = uv;
    vWorldPos = wp.xyz;
    vDist = distance(wp.xyz, cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * wp;

    #ifdef TAA_ENABLED
      // The sand does not move. Recentering the disc on the camera is not
      // motion either, so last frame's world position is this one's.
      vTaaCurrentClip = gl_Position;
      vTaaPreviousClip = uPreviousViewProjection * wp;
    #endif
  }
