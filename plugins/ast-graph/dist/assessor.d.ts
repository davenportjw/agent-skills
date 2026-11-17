import type { ProjectAssessmentManifest } from './types.js';
export declare function canonicalizeWorkspaceRoot(workspaceRoot: string): string;
export declare function computeRepoId(canonicalRoot: string): string;
export declare function findEnclosingRepoRoot(targetPath: string): string | null;
export interface GitWorkspaceInfo {
    gitDir: string;
    commonDir: string;
    isWorktree: boolean;
    parentRepoRoot: string | null;
}
/**
 * Resolves `.git` directory metadata for both standard checkouts (`.git/` dir)
 * and linked Git worktrees / submodules (`.git` pointer file with `gitdir:` + `commondir`).
 */
export declare function resolveGitInfo(workspaceRoot: string): GitWorkspaceInfo | null;
/**
 * Reads the current Git HEAD state (`<ref>:<sha>` or `detached:<sha>`) directly from `.git`
 * without spawning a subprocess (<0.1ms), supporting linked worktrees and `packed-refs`.
 */
export declare function resolveGitHeadSignature(workspaceRoot: string): string | null;
export declare function ensureGitExclude(canonicalRoot: string): boolean;
export declare function getGlobalRegistryPath(): string;
export declare function registerWorkspaceInGlobalRegistry(manifest: ProjectAssessmentManifest): void;
export declare function unregisterWorkspaceFromGlobalRegistry(workspaceRoot: string): boolean;
export declare function pruneGlobalRegistry(): {
    removed: string[];
    kept: string[];
};
export declare function getRegisteredWorkspaces(): ProjectAssessmentManifest[];
export declare function assessWorkspace(workspaceRoot: string): ProjectAssessmentManifest;
//# sourceMappingURL=assessor.d.ts.map