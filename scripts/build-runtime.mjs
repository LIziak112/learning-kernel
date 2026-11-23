import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import project from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, process.argv[2] ?? "target/runtime");
const outputPath = relative(join(root, "target"), output);
if (!outputPath || outputPath === ".." || outputPath.startsWith(".." + sep) || isAbsolute(outputPath)) {
  throw new Error("运行产物须输出到 target 的独立子目录");
}
const require = createRequire(import.meta.url);
const compiler = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.build.json", "--outDir", output], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

mkdirSync(output, { recursive: true });
for (const path of ["practices", "src/host/web"]) {
  cpSync(join(root, path), join(output, path), { recursive: true });
}
writeFileSync(join(output, "package.json"), JSON.stringify({
  name: project.name, version: project.version, private: true, type: "module",
  engines: project.engines, dependencies: project.dependencies,
  exports: { ".": { types: "./src/server.d.ts", node: "./src/server.js" } },
  files: ["src/server.js", "src/server.d.ts", "src/contracts", "src/extensions", "src/kernel"],
}, null, 2) + "\n");
console.log(`运行产物 ${output}`);
