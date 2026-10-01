/**
 * common/http.js — Inter-service HTTP helper: `serviceFetch` (trace-propagating
 * fetch with timeout) from telemetry.js. All cross-service calls in Animaxia
 * Cloud go through this so distributed tracing stays end-to-end.
 */

export { serviceFetch, currentTrace, injectTrace } from './telemetry.js';
