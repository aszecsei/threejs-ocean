// Seabed shading.
//
// Deliberately thin: the seabed is never seen except through several metres
// of water, and the underwater resolve pass owns the fog, so anything spent
// on a rich surface model here is spent on something the medium is about to
// take away. What it does have to get right is the light -- which arrives
// refracted, attenuated by depth, and (once the caustic map exists) banded.

  uniform sampler2D uSeabedTex;
  uniform float uSeabedTile;
  uniform vec3 uSandColor;
  uniform vec3 uCoarseColor;
  uniform float uSeabedNormalStrength;

  varying vec3 vWorldPos;
  varying vec2 vSandUv;
  varying float vDist;
  #ifdef TAA_ENABLED
    varying vec4 vTaaCurrentClip;
    varying vec4 vTaaPreviousClip;
  #endif

  #include "../../ocean/underwater/shaders/scatter.glsl";
  #include "../../taa/shaders/contract.glsl";

  void main() {
    vec4 tex = texture2D(uSeabedTex, vSandUv);

    // World-space normal straight off the heightfield: the seabed is a
    // heightfield in xz, so its tangent frame is the world frame and there is
    // no basis to build. Damped with distance for the same reason the ocean
    // damps its detail normal -- past a few tens of metres the relief is
    // sub-texel and would only alias.
    vec2 slope = (tex.rg * 2.0 - 1.0) * uSeabedNormalStrength * exp(-vDist * 0.02);
    vec3 N = normalize(vec3(slope.x, 1.0, slope.y));

    vec3 albedo = mix(uSandColor, uCoarseColor, tex.b);

    float depth = max(uWaterLevel - vWorldPos.y, 0.0);
    // Sunlight reaching this depth, along the refracted ray. uWaterSunDirection
    // points downward, so the cosine wants its negation.
    float sunRun = 1.0 / max(-uWaterSunDirection.y, 0.05);
    vec3 sun = uWaterIrradiance * exp(-uWaterSigmaT * (depth * sunRun));
    float ndl = max(dot(N, -uWaterSunDirection), 0.0);

    // Ambient is the diffuse downwelling at this depth -- the same quantity
    // the volume's multiple-scattering term is built on, so the floor and the
    // water in front of it agree about how dark it is down here.
    vec3 ambient = waterDownwelling(depth) * 0.16;

    vec3 col = albedo * (ambient + sun * ndl * waterCaustic(vWorldPos, depth) * 0.09);

    gl_FragColor = vec4(col, 1.0);
    #ifdef TAA_ENABLED
      taaMotion = taaPackMotion(vTaaCurrentClip, vTaaPreviousClip, 0.0);
    #endif
  }
