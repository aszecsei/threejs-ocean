// Caustic photon splat, after Papadopoulos & Papaioannou (GraphiCon 09).
//
// One vertex per photon. Each starts on a grid over the sea surface, is
// refracted through the wave normal there, and is projected to wherever it
// lands on the sea floor. Rasterised additively, the *density* of the landings
// is the caustic intensity -- no Jacobian, no divergence estimate, nothing to
// tune. Where the surface focuses light the photons pile up and the texel goes
// bright; where it spreads them the texel goes dark.
//
// The paper does this with a geometry shader subdividing a coarse grid. WebGL2
// has none, but it does not need one: a THREE.Points cloud of the final photon
// count is the same draw with the subdivision done once, on the CPU, at build.

  // Only the coarse cascade. Not a shortcut -- a cut-off with a reason.
  //
  // A ripple of wavelength L and amplitude a has a radius of curvature near
  // L^2/(4 pi^2 a), so it brings light to a focus a few times that below the
  // surface. The fine cascade's 13 cm ripples focus within a metre or two and
  // have long since crossed back over into noise by the time they reach
  // fifteen metres; refracting through them produces uniform speckle at the
  // floor, not caustics. Only wavelengths whose focus is near the seabed draw
  // a pattern there, and on this sea those all live in the coarse cascade.
  uniform sampler2D uDisplace;
  uniform sampler2D uFoam;
  uniform float uPatchSize;
  /** Steepens the surface, trading physical accuracy for a readable net. */
  uniform float uSlopeScale;

  uniform vec3 uSunDirection;
  uniform float uWaterIor;

  uniform vec2 uEmitCenter;
  uniform float uEmitExtent;
  uniform vec2 uMapCenter;
  uniform float uMapExtent;
  uniform float uPhotonSize;

  #ifdef WATER_CAUSTIC_SEABED
  #include "../../../seabed/shaders/seabed-height.glsl";
  #else
  uniform float uSeabedDepth;
  float seabedHeight(vec2 xz) { return -uSeabedDepth; }
  #endif

  void main() {
    // position.xz is the photon's cell in [-0.5, 0.5]^2.
    vec2 xz = uEmitCenter + position.xz * uEmitExtent;

    vec2 uv = xz / uPatchSize;
    float surfaceY = texture2D(uDisplace, uv).y;

    // The foam texture packs the surface normal in yzw. Recovering the slope
    // and scaling it before rebuilding the normal is how the net's contrast
    // is set: it steepens the surface rather than brightening the result, so
    // the pattern sharpens instead of washing out.
    //
    // Guarded because a degenerate fetch normalizes to NaN, and a NaN
    // gl_Position discards the photon silently -- the map goes black with
    // nothing in the console to say why.
    vec4 foam = texture2D(uFoam, uv);
    vec3 Nraw = dot(foam.yzw, foam.yzw) > 1e-8 ? normalize(foam.yzw) : vec3(0.0, 1.0, 0.0);
    vec2 slope = -Nraw.xz / max(Nraw.y, 1e-3) * uSlopeScale;
    vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

    vec3 p = vec3(xz.x, surfaceY, xz.y);
    // Air into water: the normal already points at the incident side.
    vec3 T = refract(-uSunDirection, N, 1.0 / uWaterIor);

    // Down to the mean floor, then one refinement against its heightfield.
    // This is the paper's iterative ray-surface step (after Shah &
    // Konttinen), run against an analytic field instead of a depth buffer,
    // which converges in one pass because the field can be evaluated at the
    // guess rather than only along the ray.
    float run = 1.0 / max(-T.y, 1e-3);
    vec3 hit = p + T * ((p.y - seabedHeight(p.xz)) * run);
    hit = p + T * ((p.y - seabedHeight(hit.xz)) * run);

    vec2 muv = (hit.xz - uMapCenter) / uMapExtent + 0.5;
    gl_Position = vec4(muv * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = uPhotonSize;
  }
