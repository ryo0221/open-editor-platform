/**
 * One version commit at a time across the Playground: Ctrl+S (App's saveVersion) and a drawing's
 * issue (DW6b) both commit a version from the record they read first, so neither may start while
 * the other is still writing (Codex on #1246).
 */
export const versionCommit = { current: false };
