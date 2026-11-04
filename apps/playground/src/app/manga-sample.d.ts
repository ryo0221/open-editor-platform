declare module 'virtual:playground-manga-tools' {
  export const MangaArtTools:
    | import('react').ComponentType<{ host: import('./editor-surfaces').SurfaceHost }>
    | undefined;
}
