declare module 'virtual:bundled-counter' {
  export const pins: Readonly<Record<string, string>>;
  export const packages: {
    manifest: import('@editor-platform/extension-runtime/package').PackageManifest;
    entry: string;
    files: { path: string; text: string }[];
  }[];
}
