import { execFileSync } from "node:child_process";

export function resolveExecutable(name) {
  return execFileSync("which", [name], { encoding: "utf8" }).trim();
}
