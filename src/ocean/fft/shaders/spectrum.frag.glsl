// Evolves the h0 spectrum to time t and writes it bit-reversed, ready for the
// butterfly passes. Dispersion here must match the JS mirror in spectrum math
// exactly, or amplitudes and time evolution describe different waves.

  uniform sampler2D uH0;
  uniform float uTime;
  uniform float uSize;
  uniform float uBits;
  uniform float uPatchSize;
  uniform float uDepth;

  // GLSL ES 1.00 has no tanh. Argument is k*depth, never negative.
  float tanhf(float x) {
    float e = exp(-2.0 * min(x, 20.0));
    return (1.0 - e) / (1.0 + e);
  }

  vec2 cmul(vec2 a, vec2 b) {
    return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
  }

  float bitrev(float x) {
    float r = 0.0;
    for (int i = 0; i < 12; i++) {
      if (float(i) >= uBits) break;
      r = r * 2.0 + mod(x, 2.0);
      x = floor(x * 0.5);
    }
    return r;
  }

  void main() {
    vec2 p = floor(gl_FragCoord.xy);
    float n = bitrev(p.x);
    float m = bitrev(p.y);

    float sn = (n <= 0.5 * uSize) ? n : n - uSize;
    float sm = (m <= 0.5 * uSize) ? m : m - uSize;
    vec2 k = vec2(sn, sm) * (6.2831853 / uPatchSize);
    float klen = length(k);
    float klenS = max(klen, 1e-5);

    // Must match dispersion() in this file exactly — same clamp, same
    // form. The CPU picks amplitudes for these waves; if the GPU then
    // evolves different ones, the spectrum and the motion disagree.
    float w = sqrt(9.81 * klenS * tanhf(klenS * uDepth));
    vec2 epos = vec2(cos(w * uTime), sin(w * uTime));
    vec2 eneg = vec2(epos.x, -epos.y);

    vec4 h0  = texture2D(uH0, (vec2(n, m) + 0.5) / uSize);
    vec2 nc  = vec2(mod(uSize - n, uSize), mod(uSize - m, uSize));
    vec4 h0c = texture2D(uH0, (nc + 0.5) / uSize);

    vec2 h = cmul(h0.xy, epos) + cmul(h0.zw, eneg);
    vec2 khat = k / klenS;
    // Choppy (Gerstner) spectrum: D~ = +i * khat * h~. Tessendorf writes
    // -i, but that assumes a e^{-ikx} transform; our butterflies use
    // e^{+ikx} (see buildButterflyTexture), and with that sign the +i
    // form is what moves points TOWARD crests (h = cos(kx) -> D = -sin(kx)).
    // Using -i here pinches the troughs instead and foams the valleys.
    vec2 iH = vec2(-h.y, h.x); // i * h

    #if defined(CHAIN_C)
      // RG = dh/dx spectrum, BA = dh/dz spectrum. Note the RAW k, not khat:
      // the choppy chains normalize the wavevector, the slope chains must
      // not — d/dx of e^{+ikx} is +i*k.x, unnormalized. Same +i as the
      // choppy term for the same reason (our kernel is e^{+ikx}).
      gl_FragColor = vec4(iH * k.x, iH * k.y);
    #elif defined(CHAIN_B)
      // RG = choppy-z spectrum, BA unused
      gl_FragColor = vec4(iH * khat.y, vec2(0.0));
    #else
      // RG = height spectrum, BA = choppy-x spectrum
      gl_FragColor = vec4(h, iH * khat.x);
    #endif
  }
