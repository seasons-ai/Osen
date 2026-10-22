import { join, resolve } from "node:path";

// ELECTRON_RUN_AS_NODE is needed only to start this process; participants (claude, codex) must not inherit it
export function dropRunAsNode(env: Record<string, string | undefined>): void {
  delete env["ELECTRON_RUN_AS_NODE"];
}

// dir is the folder of the bundled entry: Contents/Resources/app.asar.unpacked/out/main. Not process.resourcesPath: it is unset in Node mode
export function bundlePaths(dir: string) {
  const resources = resolve(dir, "../../..");
  return {
    resources,
    templates: join(resources, "templates"),
    scenarios: join(resources, "scenarios"),
    council: join(dir, "council.mjs"),
    pdfExtract: join(dir, "pdf-extract.mjs"),
    docExtract: join(dir, "doc-extract.mjs"),
    htmlWorker: join(dir, "html-worker.mjs"),
  };
}
