import * as THREE from "three";
import * as flags from "./flags.js";
import { CLOUD_DENSITY_GLSL } from "./cloud-density.glsl.js";
import { TAA_FRAGMENT_GLSL, taaMaterialConfig, type TaaHandle } from "./taa.js";
import type { Defines, Uniform } from "./core/types.js";

const RESOLUTION = 256;
// Ocean radius is 380 world units. Cover its full 760-unit diameter plus a
// 40-unit margin on every side so the transmitting fallback stays offscreen.
const EXTENT = 840;
const QUAD_VERT = /* glsl */ `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`;

/** Cloud-shadow map state; "debug" renders the map itself over the frame. */
export type CloudShadowMode = "off" | "on" | "debug";

export function cloudShadowMode(): CloudShadowMode {
  if (!flags.enabled("cloud-shadows")) return "off";
  return flags.is("cloud-shadows", "debug") || flags.is("cloud-debug", "shadow") ? "debug" : "on";
}

export function createCloudShadows(
  renderer: THREE.WebGLRenderer,
  densityUniforms: Record<string, Uniform<unknown>>,
  densityDefines: Defines,
  taa: TaaHandle | null = null
) {
  const mode = cloudShadowMode();
  if (mode === "off" || !renderer.capabilities.isWebGL2) return null;
  const makeTarget = () => new THREE.WebGLRenderTarget(RESOLUTION, RESOLUTION, {
    type: THREE.HalfFloatType,
    format: THREE.RedFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  let targets = [makeTarget(), makeTarget()];
  let readIndex = 0, historyValid = false, resetCount = 0;
  const center = new THREE.Vector2();
  const previousCenter = new THREE.Vector2();
  const worldTexel = EXTENT / RESOLUTION;
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { ...densityDefines, SHADOW_STEPS: "16" },
    uniforms: {
      ...densityUniforms,
      tShadowHistory: { value: null },
      uShadowCenter: { value: center },
      uPreviousShadowCenter: { value: previousCenter },
      uShadowExtent: { value: EXTENT },
      uShadowHistoryValid: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uSunDirection;
      uniform sampler2D tShadowHistory;
      uniform vec2 uShadowCenter,uPreviousShadowCenter;
      uniform float uShadowExtent,uShadowHistoryValid;
      ${CLOUD_DENSITY_GLSL}
      layout(location=0) out vec4 shadowColor;
      void main(){
        vec3 sd=normalize(uSunDirection);
        vec2 receiverXZ=uShadowCenter+(vUv-0.5)*uShadowExtent;
        float s0=(CLOUD_BOTTOM-0.0)/max(sd.y,1e-4);
        float s1=(CB_TOP-0.0)/max(sd.y,1e-4);
        float span=max(s1-s0,0.0);
        float stepLen=span/float(SHADOW_STEPS);
        // Centered strata stay fixed in receiver space. With sixteen slices
        // the slab is resolved without the sparkling caused by random ray
        // offsets on neighboring shadow texels.
        float jitter=0.5;
        float opticalDepth=0.0;
        for(int i=0;i<SHADOW_STEPS;i++){
          float rayS=s0+(float(i)+jitter)*stepLen;
          vec3 p=vec3(receiverXZ.x,0.0,receiverXZ.y)+sd*rayS;
          opticalDepth+=coarseCloudDensity(p)*stepLen;
        }
        float current=exp(-opticalDepth*EXTINCTION);
        vec2 worldXZ=uShadowCenter+(vUv-0.5)*uShadowExtent;
        vec2 previousUv=(worldXZ-uPreviousShadowCenter)/uShadowExtent+0.5;
        float inside=float(all(greaterThanEqual(previousUv,vec2(0.0)))&&all(lessThanEqual(previousUv,vec2(1.0))));
        float history=texture(tShadowHistory,previousUv).r;
        float blend=0.86*uShadowHistoryValid*inside;
        shadowColor=vec4(mix(current,history,blend),0.0,0.0,1.0);
      }
    `,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);
  scene.add(quad);
  const taaConfig = taaMaterialConfig(taa);
  const debugMaterial = new THREE.ShaderMaterial({
    glslVersion: taaConfig.glslVersion,
    defines: taaConfig.defines,
    uniforms: { tShadow: { value: null } },
    depthTest: false, depthWrite: false,
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tShadow; varying vec2 vUv;
      ${TAA_FRAGMENT_GLSL}
      void main(){ float s=texture2D(tShadow,vUv).r; gl_FragColor=vec4(vec3(s),1.0);
      #ifdef TAA_ENABLED
        taaMotion=vec4(0.0,0.0,0.0,1.0);
      #endif
      }
    `,
  });
  const api = {
    mode,
    center,
    extent: EXTENT,
    uniforms: {
      tCloudShadow: { value: targets[readIndex].texture },
      uCloudShadowCenter: { value: center },
      uCloudShadowExtent: { value: EXTENT },
      uCloudShadowEnabled: { value: 1 },
      uCloudShadowSunDirection: densityUniforms.uSunDirection,
    },
    get texture(){ return targets[readIndex].texture; },
    get target(){ return targets[readIndex]; },
    get historyValid(){ return historyValid; },
    get resetCount(){ return resetCount; },
    update(cameraPosition: THREE.Vector3){
      const snappedX=Math.floor(cameraPosition.x/worldTexel)*worldTexel;
      const snappedY=Math.floor(cameraPosition.z/worldTexel)*worldTexel;
      previousCenter.copy(center);
      center.set(snappedX,snappedY);
      const writeIndex=1-readIndex;
      material.uniforms.tShadowHistory.value=targets[readIndex].texture;
      material.uniforms.uShadowHistoryValid.value=historyValid?1:0;
      renderer.setRenderTarget(targets[writeIndex]);
      renderer.render(scene,camera);
      readIndex=writeIndex;historyValid=true;
      api.uniforms.tCloudShadow.value=targets[readIndex].texture;
    },
    renderDebug(frame: THREE.WebGLRenderTarget){
      if(mode!=="debug")return;
      debugMaterial.uniforms.tShadow.value=targets[readIndex].texture;
      quad.material=debugMaterial;
      renderer.setRenderTarget(frame);
      renderer.render(scene,camera);
      quad.material=material;
    },
    reset(){ resetCount++; historyValid=false; },
    dispose(){ targets.forEach(t=>t.dispose());material.dispose();debugMaterial.dispose();quad.geometry.dispose(); },
  };
  return api;
}

/**
 * Makes a standard-lit material receive the cloud shadow map.
 *
 * This rewrites three.js's own shader source by literal string match,
 * including the body of the `lights_fragment_begin` chunk. Every replace here
 * is a silent no-op if the needle moves in a three.js upgrade: the shader
 * still compiles and the shadow simply disappears. scripts/probe-shader-patches.js
 * asserts that each one still finds its target.
 */
export function attachCloudShadow(
  material: THREE.Material | null | undefined,
  shadowUniforms: Record<string, Uniform<unknown>> | null | undefined
): void {
  if (!material || !shadowUniforms) return;
  const prior = material.onBeforeCompile?.bind(material);
  material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => {
    if (prior) prior(shader, renderer);
    Object.assign(shader.uniforms, shadowUniforms);
    shader.vertexShader = shader.vertexShader.replace(
      "void main() {",
      "varying vec3 vCloudShadowWorld;\nvoid main() {"
    ).replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vCloudShadowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;"
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      `uniform sampler2D tCloudShadow;\nuniform vec2 uCloudShadowCenter;\nuniform float uCloudShadowExtent;\nuniform float uCloudShadowEnabled;\nuniform vec3 uCloudShadowSunDirection;\nvarying vec3 vCloudShadowWorld;\nfloat cloudReceiverShadow(){ vec2 uv=(vCloudShadowWorld.xz-uCloudShadowCenter)/uCloudShadowExtent+0.5; float inside=step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0); return mix(1.0,texture2D(tCloudShadow,uv).r,inside*uCloudShadowEnabled); }\nvoid main() {`
    );
    // Patch the directional-light loop itself so only the key light whose
    // direction matches the cloud field's sun is attenuated. Rim and any
    // future direct lights keep their original contribution.
    const directionalChunk = THREE.ShaderChunk.lights_fragment_begin.replace(
      "\t\tgetDirectionalLightInfo( directionalLight, directLight );",
      "\t\tgetDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= mix( 1.0, cloudReceiverShadow(), smoothstep( 0.995, 0.9995, dot( normalize( directLight.direction ), normalize( ( viewMatrix * vec4( uCloudShadowSunDirection, 0.0 ) ).xyz ) ) ) );"
    );
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_begin>", directionalChunk);
  };
  const priorKey=material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey=()=>`${priorKey?priorKey():""}|cloud-shadow-v2-sun-only`;
  material.needsUpdate=true;
}

/** The cloud shadow-map rig returned by {@link createCloudShadows}. */
export type CloudShadows = NonNullable<ReturnType<typeof createCloudShadows>>;
