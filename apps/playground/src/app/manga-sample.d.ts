declare module 'virtual:playground-manga-tools' {
  export const MangaArtTools:
    | import('react').ComponentType<{ host: import('../kinds/surface-host').SurfaceHost }>
    | undefined;
}
