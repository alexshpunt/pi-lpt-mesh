// shared/workspace.ts — broker-comparable workspace tree positions.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Logical position derived from the session's working directory. */
export interface WorkspaceDescriptor {
  projectId: string;
  worktreeId: string;
  path: string[];
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}
function canonical(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}
function components(p: string): string[] {
  const parsed = path.parse(p);
  const relative = p.slice(parsed.root.length);
  return [parsed.root, ...relative.split(path.sep).filter(Boolean)];
}
function nestedPath(root: string, cwd: string): string[] {
  const rel = path.relative(root, cwd);
  return rel === "" ? [] : rel.split(path.sep).filter(Boolean);
}
/** Derive a stable workspace descriptor from the actual session cwd. */
export function deriveWorkspaceDescriptor(cwd: string = process.cwd()): WorkspaceDescriptor {
  const current = canonical(cwd);
  const topRaw = git(current, ["rev-parse", "--show-toplevel"]);
  if (topRaw === null) return { projectId: "fs", worktreeId: "root", path: components(current) };
  const top = canonical(topRaw);
  const commonRaw = git(current, ["rev-parse", "--git-common-dir"]);
  const common = canonical(commonRaw === null ? path.join(top, ".git") : path.resolve(current, commonRaw));
  const mainRoot = path.basename(common) === ".git" ? path.dirname(common) : top;
  const projectId = `git:${common}`;
  let worktreeId = "root";
  if (top !== canonical(mainRoot)) {
    const gitDirRaw = git(current, ["rev-parse", "--git-dir"]);
    const gitDir = gitDirRaw === null ? "" : canonical(path.resolve(current, gitDirRaw));
    const marker = `${path.sep}worktrees${path.sep}`;
    const markerIndex = gitDir.lastIndexOf(marker);
    worktreeId = markerIndex >= 0 ? gitDir.slice(markerIndex + marker.length) : path.basename(top);
    if (worktreeId === "") worktreeId = path.basename(top);
  }
  return { projectId, worktreeId, path: nestedPath(top, current) };
}
/** Validate the bounded, path-only descriptor carried during hello. */
export function isValidWorkspaceDescriptor(value: unknown): value is WorkspaceDescriptor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.projectId !== "string" || v.projectId.length === 0 || v.projectId.length > 4096) return false;
  if (typeof v.worktreeId !== "string" || v.worktreeId.length === 0 || v.worktreeId.length > 512) return false;
  if (!Array.isArray(v.path) || v.path.length > 256) return false;
  return v.path.every((part) => typeof part === "string" && part.length > 0 && part.length <= 255 && part !== "." && part !== "..");
}
function logicalPath(w: WorkspaceDescriptor): string[] {
  return w.worktreeId === "root" ? w.path : [w.worktreeId, ...w.path];
}
function ancestor(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((v, i) => b[i] === v);
}
/** True when positions are equal or on the same ancestor/descendant branch. */
export function sameWorkspaceBranch(a: WorkspaceDescriptor, b: WorkspaceDescriptor): boolean {
  return a.projectId === b.projectId && (ancestor(logicalPath(a), logicalPath(b)) || ancestor(logicalPath(b), logicalPath(a)));
}
/** True when a shared non-default room deliberately crosses tree boundaries. */
export function sharesNonDefaultRoom(a: readonly string[], b: readonly string[]): boolean {
  return a.some((room) => room !== "default" && b.includes(room));
}
/** Visibility is branch ancestry or any shared non-default room. */
export function canSeeWorkspace(from: WorkspaceDescriptor, fromRooms: readonly string[], target: WorkspaceDescriptor, targetRooms: readonly string[]): boolean {
  return sameWorkspaceBranch(from, target) || sharesNonDefaultRoom(fromRooms, targetRooms);
}
/** Delivery crosses a tree boundary only through the selected shared non-default room. */
export function canDeliverWorkspace(from: WorkspaceDescriptor, fromRooms: readonly string[], target: WorkspaceDescriptor, targetRooms: readonly string[], room: string): boolean {
  return sameWorkspaceBranch(from, target) || (room !== "default" && fromRooms.includes(room) && targetRooms.includes(room));
}
/** Backwards-compatible concise derivation name. */
export const deriveWorkspace = deriveWorkspaceDescriptor;
