// shared/semantic.ts — semantic mesh identity and alias helpers.

export interface SemanticIdentity {
  repo: string;
  worktree: string;
  role: string;
}

/** Convert a component to the mesh slug grammar. */
export function normalizeSemanticSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Validate and normalize a structured identity, naming the bad component. */
export function normalizeSemanticIdentity(value: unknown): SemanticIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid semantic identity");
  }
  const raw = value as Record<string, unknown>;
  const result: SemanticIdentity = { repo: "", worktree: "", role: "" };
  for (const key of ["repo", "worktree", "role"] as const) {
    if (typeof raw[key] !== "string") throw new Error(`invalid semantic identity ${key}`);
    const slug = normalizeSemanticSlug(raw[key]);
    if (slug === "") throw new Error(`invalid semantic identity ${key}: empty slug`);
    result[key] = slug;
  }
  return result;
}

export function semanticAlias(identity: SemanticIdentity, index = 1): string {
  const base = `${identity.repo}-${identity.worktree}-${identity.role}`;
  return index <= 1 ? base : `${base}-${index}`;
}

/** Return the tuple encoded by a semantic alias, or null when unrelated. */
export function aliasMatchesIdentity(alias: string, identity: SemanticIdentity): boolean {
  const base = semanticAlias(identity);
  return alias === base || /^\d+$/.test(alias.slice(base.length + 1)) && alias.startsWith(`${base}-`);
}
