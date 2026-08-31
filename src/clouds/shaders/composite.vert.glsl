// Composite quad. Depth 0.99985 keeps it just inside the far plane so the
// clouds sit behind scene geometry.
varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.99985,1.0);}