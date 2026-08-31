import * as THREE from "three";
import * as flags from "../../flags.js";
import type { OceanRig } from "../index.js";
import type { SeabedRig } from "../../seabed/index.js";
import type { WaterMedium } from "./water.js";
import FULLSCREEN_VERT from "../../shaders/common/fullscreen.vert.glsl";
import CAUSTICS_VERT from "./shaders/caustics.vert.glsl";
import CAUSTICS_FRAG from "./shaders/caustics.frag.glsl";
import CAUSTICS_BLUR_FRAG from "./shaders/caustics-blur.frag.glsl";

// --- Caustic map -------------------------------------------------------------
// Papadopoulos & Papaioannou's photon splat (GraphiCon 09), as a plain
// THREE.Points draw: one vertex per photon, refracted through the FFT surface
// in the vertex shader and projected to where it lands on the sea floor. The
// density of the landings is the caustic intensity.
//
// Read back by the seabed (the pattern on the sand) and by the shaft
// raymarch (the banding inside the beams), which is what makes the two agree:
// a shaft carries the caustic of the patch of floor it ends on.

export const CAUSTICS_DEFAULTS = {
  /** Resolution of the map. */
  SIZE: 512,
  /** Photons per side. Equal to SIZE so a flat sea puts exactly one photon
   *  on each texel, which is what makes the map a ratio against no waves. */
  PHOTONS: 512,
  /** World span of the map, metres. Past this the water has taken the light
   *  anyway, so a wider map buys nothing but texels. */
  EXTENT: 110.0,
  /** Rasterised photon width, texels. Wider than one so the splat has
   *  something for the blur to work with instead of isolated speckle. */
  PHOTON_SIZE: 2.0,
  /** How much the emit grid overhangs the map, to cover photons that drift
   *  in from outside it once the surface spreads them. */
  EMIT_MARGIN: 1.25,
  /** Contrast of the pattern against a flat sea. */
  STRENGTH: 1.0,
  /** Surface steepening, which is what sets the net's contrast. */
  SLOPE_SCALE: 2.2,
};

/** `?caustics=0` drops the map; the shafts and the sand go smooth. */
export function causticsEnabled() {
  return flags.enabled("caustics");
}

/**
 * `?caustic-slope=<n>` overrides the surface steepening, which is the knob
 * that sets how large the caustic cells are. Steeper surface, shorter focal
 * length, so the waves that happen to focus at the floor are *longer* ones
 * and the cells come out bigger. Worth being able to sweep from the URL.
 */
export function causticSlope() {
  return flags.num("caustic-slope", CAUSTICS_DEFAULTS.SLOPE_SCALE, { min: 0.05, max: 8 });
}

export interface CausticsOptions extends Partial<typeof CAUSTICS_DEFAULTS> {
  /** The sea floor the photons land on. Without one they land on a plane. */
  seabed?: SeabedRig | null;
}

export function createCaustics(
  renderer: THREE.WebGLRenderer,
  ocean: OceanRig,
  medium: WaterMedium,
  opts: CausticsOptions = {}
) {
  const o = { ...CAUSTICS_DEFAULTS, ...opts };
  const seabed = opts.seabed ?? null;

  const makeTarget = () =>
    new THREE.WebGLRenderTarget(o.SIZE, o.SIZE, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  const targets = [makeTarget(), makeTarget()];
  targets[0].texture.name = "Caustics.map";

  // One vertex per photon, carrying its cell in [-0.5, 0.5]^2. The grid is
  // built once here; the paper's geometry-shader subdivision exists only
  // because it could not.
  const count = o.PHOTONS * o.PHOTONS;
  const cells = new Float32Array(count * 3);
  for (let j = 0; j < o.PHOTONS; j++) {
    for (let i = 0; i < o.PHOTONS; i++) {
      const k = (j * o.PHOTONS + i) * 3;
      cells[k] = (i + 0.5) / o.PHOTONS - 0.5;
      cells[k + 2] = (j + 0.5) / o.PHOTONS - 0.5;
    }
  }
  const photonGeometry = new THREE.BufferGeometry();
  photonGeometry.setAttribute("position", new THREE.BufferAttribute(cells, 3));

  // A photon of width w covers w^2 texels, and each texel is covered by w^2
  // photons, so a flat sea sums to w^2 * energy. The emit grid is also spread
  // over a wider area than the map -- the same photon count across
  // margin^2 more square metres -- which thins the density by the same
  // factor. Both have to come back out for the map to mean "1 = flat sea".
  const photonEnergy = (o.EMIT_MARGIN * o.EMIT_MARGIN) / (o.PHOTON_SIZE * o.PHOTON_SIZE);

  const splatUniforms = {
    uDisplace: ocean.uniforms.uDisplace,
    uFoam: ocean.uniforms.uFoam,
    uPatchSize: ocean.uniforms.uPatchSize,
    uSlopeScale: { value: opts.SLOPE_SCALE ?? causticSlope() },
    uSunDirection: medium.uniforms.uSunDirection,
    uWaterIor: medium.uniforms.uWaterIor,
    uEmitCenter: { value: new THREE.Vector2() },
    uEmitExtent: { value: o.EXTENT * o.EMIT_MARGIN },
    uMapCenter: medium.uniforms.uCausticCenter,
    uMapExtent: { value: o.EXTENT },
    uPhotonSize: { value: o.PHOTON_SIZE },
    ...(seabed
      ? {
          uSeabedTex: seabed.uniforms.uSeabedTex,
          uSeabedDepth: seabed.uniforms.uSeabedDepth,
          uSeabedTile: seabed.uniforms.uSeabedTile,
          uSeabedRelief: seabed.uniforms.uSeabedRelief,
          uSeabedMacro: seabed.uniforms.uSeabedMacro,
        }
      : { uSeabedDepth: { value: -medium.uniforms.uCausticPlaneY.value } }),
  };

  const splatMaterial = new THREE.ShaderMaterial({
    uniforms: splatUniforms,
    defines: {
      PHOTON_ENERGY: photonEnergy.toFixed(6),
      ...(seabed ? { WATER_CAUSTIC_SEABED: "" } : {}),
    },
    vertexShader: CAUSTICS_VERT,
    fragmentShader: CAUSTICS_FRAG,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });

  const splatScene = new THREE.Scene();
  const splatCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const points = new THREE.Points(photonGeometry, splatMaterial);
  points.frustumCulled = false;
  splatScene.add(points);

  const blurMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tCaustic: { value: null as THREE.Texture | null },
      uStep: { value: new THREE.Vector2() },
    },
    depthTest: false,
    depthWrite: false,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: CAUSTICS_BLUR_FRAG,
  });
  const blurScene = new THREE.Scene();
  const blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMaterial);
  blurQuad.frustumCulled = false;
  blurScene.add(blurQuad);

  const texel = o.EXTENT / o.SIZE;
  const center = medium.uniforms.uCausticCenter.value;
  const emitCenter = splatUniforms.uEmitCenter.value;
  const planeY = seabed ? -(seabed.uniforms.uSeabedDepth.value as number) : 0;

  medium.uniforms.uCausticExtent.value = o.EXTENT;
  medium.uniforms.uCausticPlaneY.value = planeY;
  medium.uniforms.uCausticStrength.value = o.STRENGTH;
  medium.uniforms.tCaustic.value = targets[0].texture;

  return {
    get texture() { return targets[0].texture; },

    render(cameraPosition: THREE.Vector3) {
      // Snap the map to its own texel grid. Without this the whole pattern
      // slides a fraction of a texel every frame as the camera moves, which
      // reads as the sea floor crawling.
      center.set(
        Math.floor(cameraPosition.x / texel) * texel,
        Math.floor(cameraPosition.z / texel) * texel
      );

      // Photons drift downsun on the way to the floor -- at fifteen metres
      // and a sun 30 degrees off vertical in the water, most of ten metres.
      // Emitting on the map's own footprint would leave one edge bare, so
      // the grid is offset back up the refracted ray.
      const sun = medium.uniforms.uWaterSunDirection.value;
      const run = (planeY - 0) / Math.min(sun.y, -0.05);
      emitCenter.set(center.x - sun.x * run, center.y - sun.z * run);

      const previousTarget = renderer.getRenderTarget();
      const previousAutoClear = renderer.autoClear;
      renderer.autoClear = false;

      renderer.setRenderTarget(targets[0]);
      renderer.clear(true, false, false);
      renderer.render(splatScene, splatCamera);

      // Separable blur, ending back on targets[0] so the texture the medium
      // holds never changes identity.
      blurQuad.material = blurMaterial;
      blurMaterial.uniforms.tCaustic.value = targets[0].texture;
      blurMaterial.uniforms.uStep.value.set(1 / o.SIZE, 0);
      renderer.setRenderTarget(targets[1]);
      renderer.render(blurScene, splatCamera);

      blurMaterial.uniforms.tCaustic.value = targets[1].texture;
      blurMaterial.uniforms.uStep.value.set(0, 1 / o.SIZE);
      renderer.setRenderTarget(targets[0]);
      renderer.render(blurScene, splatCamera);

      renderer.autoClear = previousAutoClear;
      renderer.setRenderTarget(previousTarget);
    },

    dispose() {
      for (const t of targets) t.dispose();
      photonGeometry.dispose();
      splatMaterial.dispose();
      blurMaterial.dispose();
      blurQuad.geometry.dispose();
    },
  };
}

/** The caustic map returned by {@link createCaustics}. */
export type CausticsRig = ReturnType<typeof createCaustics>;
