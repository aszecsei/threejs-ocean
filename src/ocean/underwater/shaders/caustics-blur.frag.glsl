// Separable blur over the caustic map.
//
// The splat is a point cloud, so before this it is speckle: individual photons
// land on individual texels and the gaps between them are as visible as the
// piles. The paper filters for the same reason. Two passes of this, one per
// axis, turn the density into the smooth interference pattern it stands for
// without softening the bright filaments into mush.

  uniform sampler2D tCaustic;
  uniform vec2 uStep;
  varying vec2 vUv;

  void main() {
    // Five-tap binomial: cheap, and its kernel is close enough to Gaussian
    // that two axes of it read as radially symmetric.
    vec4 sum = texture2D(tCaustic, vUv) * 0.375;
    sum += texture2D(tCaustic, vUv + uStep) * 0.25;
    sum += texture2D(tCaustic, vUv - uStep) * 0.25;
    sum += texture2D(tCaustic, vUv + uStep * 2.0) * 0.0625;
    sum += texture2D(tCaustic, vUv - uStep * 2.0) * 0.0625;
    gl_FragColor = sum;
  }
