import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function* sourceFiles(staged, include) {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trimEnd();
  const list = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  for (const file of new Set(git(list, root).split("\0").filter(include))) {
    if (staged) yield [file, git(["show", `:${file}`], root)];
    else if (lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile()) {
      yield [file, readFileSync(join(root, file), "utf8")];
    }
  }
}
