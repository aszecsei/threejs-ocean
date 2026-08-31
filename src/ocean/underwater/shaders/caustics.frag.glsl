// One photon's worth of energy, blended additively.
//
// PHOTON_ENERGY is set so that a dead flat sea -- every photon landing on its
// own texel, none converging -- sums to exactly 1.0 per texel. That makes the
// map a *ratio*: 1 is "as bright as no waves at all", and everything above and
// below it is the surface focusing or spreading the light.

  void main() {
    gl_FragColor = vec4(PHOTON_ENERGY);
  }
