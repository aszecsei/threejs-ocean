// Verifies that the two shader string-surgery patches actually found their
// targets. Both fail SILENTLY on a three.js upgrade: String.replace with a
// missing needle is a no-op, the shader still compiles, the feature vanishes.
//
// Run: playwright-cli eval "() => import('/scripts/probe-shader-patches.js').then(m => m.default())"
export default async function probeShaderPatches() {
  const THREE = await import("three");
  const d = window.__demo;
  if (!d) return { error: "no __demo" };

  // The torus knot is the only tracked MeshStandardMaterial in the scene.
  let knot = null;
  d.scene.traverse((o) => {
    if (o.isMesh && o.material && o.material.isMeshStandardMaterial) knot = o;
  });
  if (!knot) return { error: "no standard-material mesh found" };

  // Rebuild the real r-whatever ShaderLib.standard source and push it through
  // the material's installed onBeforeCompile chain, exactly as three does.
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: {},
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
  };
  if (typeof knot.material.onBeforeCompile !== "function") {
    return { error: "knot material has no onBeforeCompile" };
  }
  knot.material.onBeforeCompile(shader, d.renderer);

  const fs = shader.fragmentShader;
  const vs = shader.vertexShader;

  return {
    // --- cloud-shadows.js attachCloudShadow ---
    cloudShadow: {
      // the uniform block + helper were injected at "void main() {"
      helperInjected: fs.includes("float cloudReceiverShadow()"),
      // the varying was injected into the vertex shader
      varyingInjected: vs.includes("varying vec3 vCloudShadowWorld"),
      // the world-position write landed after #include <begin_vertex>
      worldPosWritten: vs.includes("vCloudShadowWorld = (modelMatrix"),
      // THE fragile one: lights_fragment_begin was expanded AND the
      // getDirectionalLightInfo line was found inside it
      lightLoopPatched: fs.includes("directLight.color *= mix( 1.0, cloudReceiverShadow()"),
      // if this is still an unexpanded include, the chunk replace failed
      includeStillPresent: fs.includes("#include <lights_fragment_begin>"),
      uniformsBound: "tCloudShadow" in shader.uniforms,
    },
    // --- taa.js trackObject ---
    taa: {
      enabled: d.taa?.enabled ?? null,
      mrtOutputsInjected: fs.includes("layout(location = 1) out highp vec4 taaMotion"),
      fragColorRedefined: fs.includes("#define gl_FragColor taaColor"),
      clipVaryingsInjected: vs.includes("varying vec4 vTaaPreviousClip"),
      // appended before the final closing brace of main()
      motionWritten: fs.includes("taaMotion = vec4(taaCurrentUv"),
      projectVertexPatched: vs.includes("vTaaCurrentClip = gl_Position"),
      glslVersion: knot.material.glslVersion === THREE.GLSL3 ? "GLSL3" : String(knot.material.glslVersion),
    },
    three: THREE.REVISION,
  };
}
