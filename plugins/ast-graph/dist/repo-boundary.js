import fs from 'node:fs';
import path from 'node:path';
/**
 * Directory names that never belong to the repository's own source tree.
 * `.worktrees` / `worktrees` hold sibling git worktrees (full copies of the repo or of other repos);
 * indexing them duplicates every symbol.
 */
export const EXCLUDED_DIR_NAMES = new Set(['.worktrees', '.ast-graph', '.git', 'node_modules']);
const nestedRepoCache = new Map();
/**
 * True when `absDir` is the root of a different git checkout nested inside the indexed repo:
 * a git worktree (`.git` file), a submodule, or a vendored clone (`.git` directory).
 * The indexed workspace root itself is never excluded.
 */
export function isNestedRepoRoot(absDir) {
    const cached = nestedRepoCache.get(absDir);
    if (cached !== undefined)
        return cached;
    let nested = false;
    try {
        nested = fs.existsSync(path.join(absDir, '.git'));
    }
    catch {
        nested = false;
    }
    nestedRepoCache.set(absDir, nested);
    return nested;
}
/** Whether a directory encountered while walking `workspaceRoot` should be pruned. */
export function isExcludedSubtree(absDir, workspaceRoot) {
    const name = path.basename(absDir);
    if (EXCLUDED_DIR_NAMES.has(name))
        return true;
    if (workspaceRoot && path.resolve(absDir) === path.resolve(workspaceRoot))
        return false;
    return isNestedRepoRoot(absDir);
}
/**
 * True when any directory between `workspaceRoot` (exclusive) and the file is excluded.
 * Used to filter explicit target paths (hooks, incremental syncs) that bypass the walkers.
 */
export function isPathInExcludedSubtree(absFile, workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    const rel = path.relative(root, path.resolve(absFile));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
        return false;
    const parts = rel.split(path.sep);
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = path.join(cur, parts[i]);
        if (isExcludedSubtree(cur, root))
            return true;
    }
    return false;
}
/** Test hook: nested-repo detection is cached per process. */
export function clearRepoBoundaryCache() {
    nestedRepoCache.clear();
}
//# sourceMappingURL=repo-boundary.js.map