// Water mask: which side of the surface each pixel is looking at.
//
// Paired with the ocean's own vertex shader, so the mask lands on exactly the
// displaced surface the ocean draws -- anything else and the meniscus would
// sit a wave-height away from the waterline. Depth-tested, so what survives is
// the *nearest* surface along each ray, which is the one that decides whether
// the camera is in air or in water on that ray.
//
//   r  1 = seen from above (front face), 0 = seen from below (back face)
//   g  distance from the camera, world units
//   b  1 wherever the ocean was drawn; the target clears to 0

  varying float vDist;

  void main() {
    gl_FragColor = vec4(gl_FrontFacing ? 1.0 : 0.0, vDist, 1.0, 1.0);
  }
