import * as THREE from "three";
import * as flags from "../flags.js";
import { bakeDiscGeometry } from "../ocean/index.js";
import { bakeSeabedTexture } from "./height-texture.js";
import { band, drain } from "../loading/scheduler.js";
import { taaMaterialConfig, type TaaApi } from "../taa/index.js";
import type { Uniform } from "../core/types.js";
import SEABED_VERT from "./shaders/seabed.vert.glsl";
import SEABED_FRAG from "./shaders/seabed.frag.glsl";

// --- The sea floor -----------------------------------------------------------
// A displaced sand plane fifteen metres down. It exists for two reasons: the
// depth fog needs something to eat other than the sky, and the sun shafts and
// caustics need somewhere to land -- without it the caustic map would be a
// modulation of the shafts and nothing else.
//
// Geometry is the ocean's own exponential radial disc, camera-following in xz
// with a world-anchored heightfield, for the same reasons the ocean uses it.
// It is an ordinary scene object, so it rides the capture pass with the torus
// knot and the underwater resolve fogs it by depth like anything else.
//
// From above the water it never shows: the ocean surface does not refract
// what is behind it, it shades a flat body colour, and it draws over the
// floor entirely. That is a simplification rather than a consequence -- a
// surface that did refract would show the sand at this depth -- but it is the
// one the ocean shader already made, and the seabed does not change it.

export const SEABED_DEFAULTS = {
  // Mean depth below the water line, metres. Sets how the caustics read more
  // than anything else does: the wavelengths that focus near the floor are
  // the only ones that draw a pattern on it, and deeper water selects longer
  // ones. By fifteen metres the net has spread into broad soft cells; ten
  // keeps it legible while staying dark enough to feel like open sea.
  DEPTH: 10.0,
  DISC_RADIUS: 380.0, // matches the ocean, so there is no gap at the horizon
  DISC_RINGS: 120,    // half the ocean's: the water hides the far field anyway
  DISC_SECTORS: 128,
  DISC_RMIN: 1.0,

  TEX_SIZE: 512,
  TILE: 26.0,         // world period of the ripple layer, metres
  RELIEF: 0.9,        // peak-to-peak height of that layer, metres
  MACRO_TILE: 6.5,    // dune tiling as a multiple of TILE (~170 m)
  MACRO_RELIEF: 4.0,  // dune height as a multiple of RELIEF
  NORMAL_STRENGTH: 1.6,
  // How the floor's light divides between the diffuse downwelling and the
  // direct refracted beam. Only the direct half carries caustics, so this
  // ratio -- not the map's own contrast -- is what decides whether the
  // pattern reads on the sand.
  AMBIENT: 0.05,
  DIRECT: 0.30,

  SAND_COLOR: 0xa89272,
  COARSE_COLOR: 0x6b6355,
};

/** `?seabed=0` removes the sea floor. */
export function seabedEnabled() {
  return flags.enabled("seabed");
}

/** `?seabed-depth=<m>` moves it. */
export function seabedDepth() {
  return flags.num("seabed-depth", SEABED_DEFAULTS.DEPTH, { min: 1, max: 200 });
}

export interface SeabedOptions extends Partial<typeof SEABED_DEFAULTS> {
  taa?: TaaApi | null;
  /** Water medium uniforms, shared by identity. Required: the floor is lit
   *  by the refracted sun and shaded against the same downwelling the volume
   *  uses, so it cannot be built without them. */
  water: Record<string, Uniform<unknown>>;
  /** Whether a caustic map exists to light the sand with. */
  caustics?: boolean;
}

export function* buildSeabed(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  opts: SeabedOptions
) {
  const o = { ...SEABED_DEFAULTS, ...opts };
  const taa = opts.taa ?? null;
  const taaConfig = taaMaterialConfig(taa);

  const texture = yield* band(
    bakeSeabedTexture(renderer, o.TEX_SIZE),
    "Seabed", 0, 0.75);

  const geometry = yield* band(
    bakeDiscGeometry(o.DISC_RINGS, o.DISC_SECTORS, o.DISC_RMIN, o.DISC_RADIUS, "Seabed"),
    "Seabed", 0.75, 1);

  const uniforms = {
    uSeabedTex: { value: texture as THREE.Texture },
    uSeabedDepth: { value: opts.DEPTH ?? seabedDepth() },
    uSeabedTile: { value: o.TILE },
    uSeabedRelief: { value: o.RELIEF },
    uSeabedMacro: { value: new THREE.Vector2(o.MACRO_TILE, o.MACRO_RELIEF) },
    uSeabedNormalStrength: { value: o.NORMAL_STRENGTH },
    uSandColor: { value: new THREE.Color(o.SAND_COLOR) },
    uCoarseColor: { value: new THREE.Color(o.COARSE_COLOR) },
    ...opts.water,
    ...taaConfig.uniforms,
  };

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SEABED_VERT,
      fragmentShader: SEABED_FRAG,
      glslVersion: taaConfig.glslVersion,
      defines: {
        ...taaConfig.defines,
        ...(opts.caustics ? { WATER_CAUSTICS: "" } : {}),
        SEABED_AMBIENT: o.AMBIENT.toFixed(4),
        SEABED_DIRECT: o.DIRECT.toFixed(4),
      },
    })
  );
  mesh.frustumCulled = false;
  scene.add(mesh);

  return {
    mesh,
    uniforms,
    params: o,
    /** Keeps the disc under the camera; the heightfield stays world-anchored. */
    update(cameraPosition: THREE.Vector3) {
      mesh.position.x = cameraPosition.x;
      mesh.position.z = cameraPosition.z;
    },
    dispose() {
      geometry.dispose();
      mesh.material.dispose();
      texture.dispose();
    },
  };
}

/** Builds the seabed in one blocking task. See {@link buildSeabed}. */
export function createSeabed(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  opts: SeabedOptions
) {
  return drain(buildSeabed(scene, renderer, opts));
}

/** The seabed rig returned by {@link createSeabed}. */
export type SeabedRig = ReturnType<typeof createSeabed>;
