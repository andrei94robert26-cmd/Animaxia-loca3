/**
 * app/assets/assets.d.ts — Ambient module declarations for bundled binary
 * assets (not covered by the react-native type definitions).
 */

declare module '*.mp4' {
  const value: number;
  export default value;
}

declare module '*.mov' {
  const value: number;
  export default value;
}
