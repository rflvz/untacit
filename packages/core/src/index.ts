/**
 * @untacit/core public API.
 *
 * Module map (docs/03 §2): schema types & constants, canonical serializer,
 * batch validator, graph store + import pipeline, entity resolver, derived
 * SQLite index, ontology diff over git.
 */

export * from './types.js';
export * from './constants.js';
export * from './ids.js';
export * from './paths.js';
export * from './git.js';
export * from './serializer/index.js';
export * from './validator/index.js';
export * from './graph/index.js';
export * from './resolver/index.js';
export * from './embeddings/index.js';
export * from './indexer/index.js';
export * from './diff/index.js';
export * from './pipeline/index.js';
