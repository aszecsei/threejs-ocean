// Full-screen quad vertex shader for post/compute passes.
// Position comes straight through in clip space at the near plane; the quad
// geometry is a PlaneGeometry(2, 2) so position.xy already spans [-1, 1].
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
