// The `window.__demo` debug handle.
//
// This is a contract with external tooling, not an internal detail:
// scripts/capture-frame.js and scripts/probe-shader-patches.js drive the demo
// through it, and playwright-cli evals reach for it by name. Renaming or
// removing a member here breaks screenshot capture silently.

import type * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { PostPipeline } from "../post.js";
import type { TaaApi } from "../taa.js";
import type { CloudRig } from "../clouds.js";
import type { OceanRig, SceneCapture } from "../ocean.js";
import type { GodRays } from "../godrays.js";

export interface DemoHandle {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  renderer: THREE.WebGLRenderer;
  post: PostPipeline;
  taa: TaaApi;

  /** Live getters: these are created after the handle is published. */
  readonly clouds: CloudRig | null;
  readonly ocean: OceanRig | null;
  readonly capture: SceneCapture | null;
  readonly godRays: GodRays | null;

  /** Assigned once the dispose closure exists. */
  dispose?: () => void;

  // --- Deterministic capture ---------------------------------------------
  /** Stops the real-time animation loop. */
  pause(): void;
  /** Restarts the real-time animation loop. */
  resume(): void;
  /** Renders `count` frames of exactly `dt` seconds starting from t = 0. */
  stepFrames(count?: number, dt?: number): void;
  /** Drops accumulated temporal history so stepping starts from a known state. */
  resetTemporal(): void;
}

declare global {
  interface Window {
    __demo: DemoHandle;
  }
}
