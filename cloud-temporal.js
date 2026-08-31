import * as THREE from "three";

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }
`;

export function cloudTemporalMode(renderer) {
  const q = new URLSearchParams(window.location.search).get("cloud-temporal");
  if (q === "0" || q === "false") return "off";
  const gl = renderer.getContext();
  const supported = renderer.capabilities.isWebGL2
    && gl.getParameter(gl.MAX_DRAW_BUFFERS) >= 3
    && gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) >= 3;
  if (!supported) return "off";
  // Full updates are the quality default. Interleaving remains an explicit
  // performance mode until its sparse reconstruction matches this image.
  return q === "interleaved" ? "interleaved" : "full";
}

export function createCloudTemporal(renderer, mode, width, height) {
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
        float depthValid=1.0-smoothstep(0.04,0.14,relativeDepth);
        float opacityChange=clamp(abs(current.a-history.a)/0.18,0.0,1.0);
        float densityChange=clamp(abs(signature.r-historySignature.r)/0.20,0.0,1.0);
        float motionPixels=length(meta.xy/uInvResolution);
        float reactive=max(meta.a,max(opacityChange,densityChange));
        float historyWeight=0.90*historyOk*depthValid*exp(-motionPixels*0.035)*(1.0-reactive);
        vec4 lo=current,hi=current;
        for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
          vec4 n=texture(tCurrentColor,vUv+vec2(float(x),float(y))*uInvResolution);
          lo=min(lo,n); hi=max(hi,n);
        }
        vec4 extent=(hi-lo)*0.12+vec4(0.008);
        history=clamp(history,lo-extent,hi+extent);
        outColor=mix(current,history,historyWeight);
        float confidence=mix(0.45,1.0,historyWeight);
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
    get texture(){ return histories[readIndex].textures[0]; },
    get metaTexture(){ return histories[readIndex].textures[1]; },
    get signatureTexture(){ return histories[readIndex].textures[2]; },
    get historyValid(){ return valid; },
    get resetCount(){ return resetCount; },
    resolve(raw){
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
      return histories[readIndex];
    },
    reset(){ resetCount++; valid=false; readIndex=0; clear(); },
    resize(w,h){
      width=w;height=h;invResolution.set(1/w,1/h);
      for(const target of histories) target.dispose();
      histories=[makeTarget(),makeTarget()];
      api.reset();
    },
    dispose(){ for(const target of histories)target.dispose(); resolveMaterial.dispose(); quad.geometry.dispose(); },
  };
  clear();
  return api;
}
