// for a "file" without a path (not from disk) webUtils.getPathForFile returns an empty string
export function droppedPaths<F>(files: readonly F[], pathOf: (file: F) => string): string[] {
  return files.map(pathOf).filter((p) => p !== "");
}
