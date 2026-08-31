import * as THREE from "three";

/** Cloud temporal-reprojection mode; "off" when the GPU cannot support it. */
export type CloudTemporalMode = "off" | "interleaved" | "full";

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }
`;

export function cloudTemporalMode(renderer: THREE.WebGLRenderer | null | undefined): CloudTemporalMode {
  const q = new URLSearchParams(window.location.search).get("cloud-temporal");
  if (q === "0" || q === "false") return "off";
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
  return q === "interleaved" ? "interleaved" : "full";
}

export function cloudBlurPasses() {
  const q = new URLSearchParams(window.location.search).get("cloud-blur");
  if (q === null) return 2;
  const n = parseInt(q, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 4) : 2;
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
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D tCurrentColor,tCurrentMeta,tCurrentSignature;
      uniform sampler2D tHistoryColor,tHistoryMeta,tHistorySignature;
      uniform vec2 uInvResolution;
      uniform float uHistoryValid,uInterleaved;
      layout(location=0) out vec4 outColor;
      layout(location=1) out vec4 outMeta;
      layout(location=2) out vec4 outSignature;
      void main(){
        vec4 current=texture(tCurrentColor,vUv);
        vec4 meta=texture(tCurrentMeta,vUv);
        vec4 signature=texture(tCurrentSignature,vUv);
        bool fresh=signature.g>0.5;
        if(!fresh && uInterleaved>0.5){
          float best=0.0;
          vec2 offsets[8]=vec2[8](vec2(1,0),vec2(-1,0),vec2(0,1),vec2(0,-1),vec2(1,1),vec2(-1,1),vec2(1,-1),vec2(-1,-1));
          for(int i=0;i<8;i++){
            vec2 uv=vUv+offsets[i]*uInvResolution;
            vec4 ns=texture(tCurrentSignature,uv);
            if(ns.g>best){ best=ns.g; current=texture(tCurrentColor,uv); meta=texture(tCurrentMeta,uv); signature=ns; }
          }
        }
        vec2 previousUv=vUv-meta.xy;
        bool inBounds=all(greaterThanEqual(previousUv,vec2(0.0)))&&all(lessThanEqual(previousUv,vec2(1.0)));
        vec4 history=texture(tHistoryColor,previousUv);
        vec4 historyMeta=texture(tHistoryMeta,previousUv);
        vec4 historySignature=texture(tHistorySignature,previousUv);
        float historyOk=uHistoryValid*float(inBounds)*step(0.25,historySignature.g);
        if(!fresh && historyOk>0.5){
          float confidence=historySignature.g*0.97;
          outColor=history;
          outMeta=vec4(meta.xy,historyMeta.z,max(historyMeta.a,1.0-confidence));
          outSignature=vec4(historySignature.r,confidence,history.a,historySignature.a);
          return;
        }
        if(!fresh && historyOk<0.5){
          outColor=current;
          outMeta=vec4(meta.xyz,1.0);
          outSignature=vec4(signature.r,0.2,current.a,signature.a);
          return;
        }
        // A valid clear sample with no usable history needs no warm-up and
        // must not mark the background reactive.
        if(current.a<0.004&&historyOk<0.5){
          outColor=current;
          outMeta=vec4(meta.xyz,0.0);
          outSignature=vec4(0.0,1.0,0.0,signature.a);
          return;
        }
        float relativeDepth=abs(meta.z-historyMeta.z)/max(min(meta.z,historyMeta.z),0.02);
        // meta.z is a contribution-weighted mean distance: on translucent
        // multi-clump rays it flickers with the march jitter, and a strict
        // window rejects history every frame (verified by visualizing
        // historyWeight). Depth only means occlusion where alpha is high.
        float depthValid=1.0-smoothstep(mix(0.35,0.04,current.a),mix(0.90,0.14,current.a),relativeDepth);
        vec4 lo=current,hi=current,neighborhood=vec4(0.0);
        for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
          vec4 n=texture(tCurrentColor,vUv+vec2(float(x),float(y))*uInvResolution);
          lo=min(lo,n); hi=max(hi,n); neighborhood+=n;
        }
        neighborhood*=1.0/9.0;
        // Variance-guided spatial pre-filter: where the 3x3 box is wide the
        // content is stochastic march noise, and pulling the sample toward
        // the neighborhood mean removes stipple and per-frame variance at
        // the source. Coherent regions (tight box) pass through untouched.
        float preNoise=smoothstep(0.12,0.45,hi.a-lo.a);
        current=mix(current,neighborhood,0.65*preNoise);
        float opacityChange=clamp(abs(current.a-history.a)/0.18,0.0,1.0);
        float densityChange=clamp(abs(signature.r-historySignature.r)/0.20,0.0,1.0);
        // Where the 3x3 alpha box is wide the content is stochastic: a
        // per-frame swing there is march-jitter noise, and resetting history
        // on it keeps the sparkle alive forever. Let the neighborhood clamp
        // bound ghosting in those regions instead of rejecting accumulation.
        float boxNoise=smoothstep(0.15,0.5,hi.a-lo.a);
        float motionPixels=length(meta.xy/uInvResolution);
        float reactive=max(meta.a,(1.0-boxNoise)*max(opacityChange,densityChange));
        float historyWeight=0.97*historyOk*depthValid*exp(-motionPixels*0.035)*(1.0-reactive);
        vec4 extent=(hi-lo)*0.30+vec4(0.008);
        history=clamp(history,lo-extent,hi+extent);
        outColor=mix(current,history,historyWeight);
        float confidence=mix(0.45,1.0,historyWeight);
        // Clouds stay excluded from the global TAA (fully reactive): TAA
        // ghosts on fuzzy translucent content, and cloud-space accumulation
        // plus the display-time edge-preserving blur handle smoothing.
        float globalReactive=clamp(outColor.a+(1.0-outColor.a)*max(reactive,1.0-confidence),0.0,1.0);
        outMeta=vec4(meta.xy,meta.z,globalReactive);
        outSignature=vec4(signature.r,confidence,outColor.a,signature.a);
      }
    `,
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
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D tSource;
      uniform vec2 uInvResolution;
      uniform float uOffset;
      layout(location=0) out vec4 outColor;
      void main(){
        vec4 center=texture(tSource,vUv);
        float lumaC=dot(center.rgb,vec3(0.299,0.587,0.114));
        vec2 o=uOffset*uInvResolution;
        vec4 sum=center;float wsum=1.0;
        vec2 taps[4]=vec2[4](vec2(o.x,o.y),vec2(-o.x,o.y),vec2(o.x,-o.y),vec2(-o.x,-o.y));
        for(int i=0;i<4;i++){
          vec4 s=texture(tSource,vUv+taps[i]);
          // Alpha similarity alone blurs cloud interiors at full strength
          // (alpha saturates to 1 there), flattening billow shading. The
          // relative-luminance term preserves interior shading gradients
          // while low-amplitude stochastic stipple still averages out.
          float lumaS=dot(s.rgb,vec3(0.299,0.587,0.114));
          float w=exp(-abs(s.a-center.a)*6.0-abs(lumaS-lumaC)*2.5/(lumaC+0.2));
          sum+=s*w;wsum+=w;
        }
        outColor=sum/wsum;
      }
    `,
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
