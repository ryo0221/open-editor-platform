declare module 'virtual:private-video-build' {
  const build: { enabled: false } | { enabled: true; integrity: string; pin: string };
  export default build;
}

declare module 'virtual:private-video-m2-build' {
  const build: { enabled: false } | { enabled: true; integrity: string; pin: string };
  export default build;
}
