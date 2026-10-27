import type { ProjectAssessmentManifest } from './types.js';
export declare function canonicalizeWorkspaceRoot(workspaceRoot: string): string;
export declare function computeRepoId(canonicalRoot: string): string;
export declare function findEnclosingRepoRoot(targetPath: string): string | null;
export declare function ensureGitExclude(canonicalRoot: string): boolean;
export declare function getGlobalRegistryPath(): string;
export declare function registerWorkspaceInGlobalRegistry(manifest: ProjectAssessmentManifest): void;
export declare function getRegisteredWorkspaces(): ProjectAssessmentManifest[];
export declare function assessWorkspace(workspaceRoot: string): ProjectAssessmentManifest;
//# sourceMappingURL=assessor.d.ts.map