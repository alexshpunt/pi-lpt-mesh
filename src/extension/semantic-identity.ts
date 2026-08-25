// extension/semantic-identity.ts — derive the current agent's broker identity.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { normalizeSemanticIdentity, normalizeSemanticSlug, semanticAlias, type SemanticIdentity } from "../shared/semantic.js";

export { normalizeSemanticSlug, semanticAlias };
export function semanticAliasBase(identity: SemanticIdentity): string {
  return semanticAlias(identity);
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** Derive repo/worktree/role from the current process and Git worktree. */
export function deriveSemanticIdentity(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): SemanticIdentity {
  const rawRole = env.PI_SUBAGENT_AGENT;
  const role = rawRole === undefined || rawRole.trim() === "" ? "agent" : normalizeSemanticSlug(rawRole);
  if (role === "") throw new Error("invalid semantic identity role: empty slug");
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top === null) {
    return normalizeSemanticIdentity({ repo: path.basename(cwd), worktree: "root", role });
  }
  const common = git(cwd, ["rev-parse", "--git-common-dir"]);
  const commonPath = common === null ? null : path.resolve(cwd, common);
  const mainRoot = commonPath !== null && path.basename(commonPath) === ".git"
    ? path.dirname(commonPath)
    : top;
  const repo = path.basename(mainRoot);
  const branch = git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  const worktree = path.resolve(top) === path.resolve(mainRoot)
    ? "root"
    : branch === null ? path.basename(top) : branch;
  return normalizeSemanticIdentity({ repo, worktree, role });
}
