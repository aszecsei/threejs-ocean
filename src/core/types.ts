// Shared type vocabulary for the render systems.
//
// The codebase is factory-function/closure style throughout -- no classes --
// so cross-module contracts are the shapes of the "rig" objects the factories
// return. These interfaces name those shapes.

import type * as THREE from "three";

/**
 * A three.js uniform slot. Deliberately mutable and deliberately not readonly:
 * sky, clouds, ocean and TAA share the *same* uniform objects by identity so
 * that one write propagates to every material that reads it.
 */
export interface Uniform<T> {
  value: T;
}

/** A bag of uniforms passed whole into a ShaderMaterial. */
export type UniformMap = Record<string, Uniform<unknown>>;

/**
 * GLSL preprocessor defines. Values are strings because that is what three.js
 * substitutes; `""` means "defined, no value". These cannot be checked against
 * the shader's `#ifdef` names -- the shader is a string at build time.
 */
export type Defines = Record<string, string>;

export interface Disposable {
  dispose(): void;
}

export interface Resizable {
  resize(): void;
}

/** Anything with temporal history that can be invalidated. */
export interface Resettable {
  reset(): void;
}

/**
 * What `taaMaterialConfig` merges into a material. Always has all three keys
 * -- on the TAA-disabled branch the uniforms/defines are simply empty -- so
 * callers can spread it unconditionally.
 */
export interface TaaMaterialConfig {
  uniforms: Record<string, Uniform<unknown>>;
  defines: Defines;
  glslVersion: THREE.GLSLVersion | null;
}
