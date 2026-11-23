import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function imports(file: string) {
  const source = readFileSync(join(root, file), "utf8");
  return [...source.matchAll(/(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)].map(match => match[1] ?? "");
}

function layerOf(file: string, specifier: string) {
  if (!specifier.startsWith(".")) return specifier.startsWith("node:") ? "node" : specifier;
  const target = relative(root, join(root, file, "..", specifier));
  return target === join("src", "server.ts") ? "server" : target.split("/")[1] ?? target;
}

const allowed: Record<string, readonly string[]> = {
  contracts: ["contracts", "node", "zod"],
  extensions: ["contracts", "extensions", "node", "zod"],
  kernel: ["contracts", "kernel", "node", "zod"],
};

test("分层依赖：契约不依赖实现，默认扩展只经契约接入，内核不导入扩展与宿主", () => {
  for (const [layer, permitted] of Object.entries(allowed)) {
    const files = sources(join("src", layer));
    assert.ok(files.length > 0);
    for (const file of files) {
      for (const specifier of imports(file)) {
        assert.ok(permitted.includes(layerOf(file, specifier)), `${file} 不得导入 ${specifier}`);
      }
    }
  }
});

test("内核与契约不出现默认作答形态、工具或评估器的标识", () => {
  const names = ["booleanOrString", "optionIndexArray", "orderedTextBlanks", "textWithOptionalTitle",
    "single-choice-group", "question-delivery", "response-group", "text-selection", "passage-select", "choice-key"];
  for (const file of [...sources(join("src", "kernel")), ...sources(join("src", "contracts"))]) {
    const source = readFileSync(join(root, file), "utf8");
    for (const name of names) assert.ok(!source.includes(`"${name}"`), `${file} 写死了 ${name}`);
    assert.doesNotMatch(source, /(?:===|!==|case|:|\?\?)\s*"choice"/, `${file} 按 choice 形态分支`);
  }
});
