import * as THREE from "three";
import * as flags from "../../flags.js";
import FULLSCREEN_VERT from "../../shaders/common/fullscreen.vert.glsl";
import RESOLVE_FRAG from "./shaders/resolve.frag.glsl";
import BLUR_FRAG from "./shaders/blur.frag.glsl";

/** Cloud temporal-reprojection mode; "off" when the GPU cannot support it. */
export type CloudTemporalMode = "off" | "interleaved" | "full";


export function cloudTemporalMode(renderer: THREE.WebGLRenderer | null | undefined): CloudTemporalMode {
  if (!flags.enabled("cloud-temporal")) return "off";
  if (!renderer) return "off";
  // isWebGL2 is checked below; getContext() is typed as the WebGL1|WebGL2
  // union, so narrow it to reach the WebGL2-only parameters.
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const supported = renderer.capabilities.isWebGL2
    && gl.getParameter(gl.MAX_DRAW_BUFFERS) >= 3
    && gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) >= 3;
  if (!supported) return "off";
  // Full updates are the quality default. Interleaving remains an explicit
  // performance mode until its sparse reconstruction matches this image.
  return flags.is("cloud-temporal", "interleaved") ? "interleaved" : "full";
}

export function cloudBlurPasses() {
  // A negative pass count falls back to the default rather than clamping.
  const n = flags.int("cloud-blur", 2);
  return n >= 0 ? Math.min(n, 4) : 2;
}

export function createCloudTemporal(
  renderer: THREE.WebGLRenderer,
  mode: CloudTemporalMode,
  width: number,
  height: number
) {
  if (mode === "off") return null;
  const makeTarget = () => {
    const target = new THREE.WebGLRenderTarget(width, height, {
      count: 3,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    target.textures[0].name = "CloudTemporal.color";
    target.textures[1].name = "CloudTemporal.meta";
    target.textures[2].name = "CloudTemporal.signature";
    return target;
  };
  let histories = [makeTarget(), makeTarget()];
  let readIndex = 0;
  let valid = false;
  let resetCount = 0;
  const invResolution = new THREE.Vector2(1 / width, 1 / height);
  const resolveMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      tCurrentColor: { value: null }, tCurrentMeta: { value: null }, tCurrentSignature: { value: null },
      tHistoryColor: { value: null }, tHistoryMeta: { value: null }, tHistorySignature: { value: null },
      uInvResolution: { value: invResolution }, uHistoryValid: { value: 0 }, uInterleaved: { value: mode === "interleaved" ? 1 : 0 },
    },
    depthTest: false,
    depthWrite: false,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: RESOLVE_FRAG,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2,2),resolveMaterial);
  scene.add(quad);

  // Display-only edge-preserving Kawase blur over the resolved color.
  // It runs after the history write and never feeds back into it, so it
  // smooths residual stochastic stipple without progressive smearing.
  // Alpha-similarity weights keep cloud/sky silhouettes crisp.
  const blurPasses = cloudBlurPasses();
  const makeBlurTarget = () => new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  let blurTargets = blurPasses > 0 ? [makeBlurTarget(), makeBlurTarget()] : null;
  let blurredTexture: THREE.Texture | null = null;
  const blurMaterial = blurPasses > 0 ? new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { tSource: { value: null }, uInvResolution: { value: invResolution }, uOffset: { value: 1.5 } },
    depthTest: false,
    depthWrite: false,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: BLUR_FRAG,
  }) : null;
  const blurScene = new THREE.Scene();
  if (blurMaterial) blurScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2), blurMaterial));

  function clear(){
    const previous=renderer.getRenderTarget();
    const previousColor=renderer.getClearColor(new THREE.Color()).clone();
    const previousAlpha=renderer.getClearAlpha();
    for(const target of histories){ renderer.setRenderTarget(target); renderer.setClearColor(0,0); renderer.clear(); }
    renderer.setClearColor(previousColor,previousAlpha);
    renderer.setRenderTarget(previous);
  }
  const api = {
    mode,
    get target(){ return histories[readIndex]; },
    get texture(){ return blurredTexture ?? histories[readIndex].textures[0]; },
    get metaTexture(){ return histories[readIndex].textures[1]; },
    get signatureTexture(){ return histories[readIndex].textures[2]; },
    get historyValid(){ return valid; },
    get resetCount(){ return resetCount; },
    resolve(raw: THREE.WebGLRenderTarget){
      const writeIndex=1-readIndex;
      resolveMaterial.uniforms.tCurrentColor.value=raw.textures[0];
      resolveMaterial.uniforms.tCurrentMeta.value=raw.textures[1];
      resolveMaterial.uniforms.tCurrentSignature.value=raw.textures[2];
      resolveMaterial.uniforms.tHistoryColor.value=histories[readIndex].textures[0];
      resolveMaterial.uniforms.tHistoryMeta.value=histories[readIndex].textures[1];
      resolveMaterial.uniforms.tHistorySignature.value=histories[readIndex].textures[2];
      resolveMaterial.uniforms.uHistoryValid.value=valid?1:0;
      renderer.setRenderTarget(histories[writeIndex]);
      renderer.render(scene,camera);
      readIndex=writeIndex; valid=true;
      // blurTargets and blurMaterial are both created iff blurPasses > 0.
      if(blurMaterial && blurTargets){
        let source=histories[readIndex].textures[0];
        for(let i=0;i<blurPasses;i++){
          const target=blurTargets[i%2];
          blurMaterial.uniforms.tSource.value=source;
          blurMaterial.uniforms.uOffset.value=1.5+i;
          renderer.setRenderTarget(target);
          renderer.render(blurScene,camera);
          source=target.texture;
        }
        blurredTexture=source;
      }
      return histories[readIndex];
    },
    reset(){ resetCount++; valid=false; readIndex=0; clear(); },
    resize(w: number, h: number){
      width=w;height=h;invResolution.set(1/w,1/h);
      for(const target of histories) target.dispose();
      histories=[makeTarget(),makeTarget()];
      if(blurTargets){for(const t of blurTargets)t.dispose();blurTargets=[makeBlurTarget(),makeBlurTarget()];blurredTexture=null;}
      api.reset();
    },
    dispose(){ for(const target of histories)target.dispose(); if(blurTargets)for(const t of blurTargets)t.dispose(); blurMaterial?.dispose(); resolveMaterial.dispose(); quad.geometry.dispose(); },
  };
  clear();
  return api;
}

/** The cloud temporal resolver returned by {@link createCloudTemporal}. */
export type CloudTemporal = ReturnType<typeof createCloudTemporal>;
