/**
 * Directory names that never belong to the repository's own source tree.
 * `.worktrees` / `worktrees` hold sibling git worktrees (full copies of the repo or of other repos);
 * indexing them duplicates every symbol.
 */
export declare const EXCLUDED_DIR_NAMES: Set<string>;
/**
 * True when `absDir` is the root of a different git checkout nested inside the indexed repo:
 * a git worktree (`.git` file), a submodule, or a vendored clone (`.git` directory).
 * The indexed workspace root itself is never excluded.
 */
export declare function isNestedRepoRoot(absDir: string): boolean;
/** Whether a directory encountered while walking `workspaceRoot` should be pruned. */
export declare function isExcludedSubtree(absDir: string, workspaceRoot?: string): boolean;
/**
 * True when any directory between `workspaceRoot` (exclusive) and the file is excluded.
 * Used to filter explicit target paths (hooks, incremental syncs) that bypass the walkers.
 */
export declare function isPathInExcludedSubtree(absFile: string, workspaceRoot: string): boolean;
/** Test hook: nested-repo detection is cached per process. */
export declare function clearRepoBoundaryCache(): void;
//# sourceMappingURL=repo-boundary.d.ts.map