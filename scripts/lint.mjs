import { parse } from "@babel/parser";
import { sourceFiles } from "./source-files.mjs";

const testNames = new Set(["test", "it", "describe", "suite"]);
const testPath = /(?:^|\/)(?:tests?|__tests__|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

function propertyName(node, key) {
  if (key?.type === "StringLiteral") return key.value;
  if (!node.computed && key?.type === "Identifier") return key.name;
}

function isFocusedCall(call) {
  const target = call.callee;
  const method = propertyName(target, target.property);
  if (method === "only") {
    const receiver = target.object;
    return testNames.has(receiver?.name ?? propertyName(receiver, receiver?.property));
  }
  return testNames.has(target.name ?? method) && call.arguments.some(argument =>
    argument.type === "ObjectExpression" && argument.properties.some(property =>
      propertyName(property, property.key) === "only" && property.value?.value !== false));
}

function inspect(file, source) {
  const report = (line, reason) => {
    console.error(`${file}:${line}: ${reason}`);
    process.exitCode = 1;
  };
  const plugins = [];
  if (/\.[cm]?tsx?$/.test(file)) plugins.push(["typescript", { dts: /\.d\.[cm]?ts$/.test(file) }]);
  if (/\.[jt]sx$/.test(file)) plugins.push("jsx");
  let tree;
  try {
    tree = parse(source, { sourceType: "unambiguous", plugins, attachComment: false });
  } catch (error) {
    report(error.loc?.line ?? 1, error.message);
    return;
  }
  const headerLine = tree.program.interpreter ? 2 : 1;
  const header = source.split(/\r\n|[\r\n\u2028\u2029]/, headerLine)[headerLine - 1];
  for (const { value, loc: { start, end } } of tree.comments) {
    if (start.line === headerLine && end.line === headerLine &&
        !header.slice(0, start.column).trim() && !header.slice(end.column).trim() &&
        /^SPDX-License-Identifier: [\w.+-]+$/.test(value.trim())) continue;
    report(start.line, "禁止源码注释和压制指令；设计理由放入 PR。");
  }
  const checkFocus = testPath.test(file);
  function visit(node) {
    if (node.type === "TSAnyKeyword") report(node.loc.start.line, "禁止显式 any，请收窄类型。");
    if (checkFocus && (node.type === "CallExpression" || node.type === "OptionalCallExpression") && isFocusedCall(node)) {
      report(node.loc.start.line, "禁止聚焦测试。");
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.filter(child => child?.type).forEach(visit);
      else if (value?.type) visit(value);
    }
  }
  visit(tree.program);
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--staged")) throw new Error("用法：node scripts/lint.mjs [--staged]");
for (const [file, source] of sourceFiles(args.length === 1, file => /\.[cm]?[jt]sx?$/.test(file))) inspect(file, source);
