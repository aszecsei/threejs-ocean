// The seabed heightfield.
//
// Shared by the seabed's own vertex stage and by the caustic splat, which has
// to find where a refracted photon lands on the floor. If the two disagreed
// by even a little the caustics would slide across the sand.

  uniform sampler2D uSeabedTex;
  uniform float uSeabedDepth;
  uniform float uSeabedTile;
  uniform float uSeabedRelief;
  uniform vec2 uSeabedMacro; // tiling multiplier, relief multiplier

  /** World y of the sea floor at a world xz. */
  float seabedHeight(vec2 xz) {
    float ripple = texture2D(uSeabedTex, xz / uSeabedTile).a - 0.5;
    float dune = texture2D(uSeabedTex, xz / (uSeabedTile * uSeabedMacro.x) + 0.37).a - 0.5;
    return -uSeabedDepth + ripple * uSeabedRelief + dune * uSeabedRelief * uSeabedMacro.y;
  }
