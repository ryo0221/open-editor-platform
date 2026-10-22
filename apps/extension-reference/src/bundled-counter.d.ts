declare module 'virtual:bundled-counter' {
  export const pins: Readonly<Record<string, string>>;
  export const packages: {
    manifest: import('./bundled-package').BundleManifest;
    entry: string;
    files: { path: string; text: string }[];
  }[];
}
