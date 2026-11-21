export type HookHarnessFormat = 'antigravity' | 'claude-code' | 'unknown';
export interface HookResult {
    harness: HookHarnessFormat;
    eventType: string;
    filePath?: string;
    workspaceRoots?: string[];
    filesUpdated: number;
    durationMs: number;
    stdoutJson: Record<string, unknown>;
}
export interface HookInvocationOptions {
    workspaceRoot?: string;
    dbPath?: string;
    useDaemon?: boolean;
    daemonHost?: string;
    daemonPort?: number;
    /**
     * How to build an index that does not exist yet. `inline` (library default) blocks until the
     * cold build finishes; `background` (used by the hook entrypoint) spawns a detached `cli.js sync`
     * so harness hook timeouts (10-20s) never kill a long first build of a large repo.
     */
    coldBuild?: 'inline' | 'background';
    /**
     * Whether SessionStart injects a short hint naming the exact CLI command, repo root and linked
     * worktrees so agents (and the subagents/swarm workers they brief) query the graph instead of
     * grepping. Defaults to true; disable with `AST_GRAPH_SESSION_HINT=0`.
     */
    sessionHint?: boolean;
}
export interface ParsedHookInput {
    harness: HookHarnessFormat;
    eventType: string;
    toolName?: string;
    filePath?: string;
    commandLine?: string;
    commandFailed?: boolean;
    workspacePaths: string[];
    rawPayload: Record<string, unknown>;
}
export type GitLifecycleAction = {
    kind: 'worktree-add';
    targetPath: string;
} | {
    kind: 'worktree-remove';
    targetPaths: string[];
} | {
    kind: 'worktree-prune';
} | {
    kind: 'head-mutation';
    repoPath: string;
} | {
    kind: 'repo-created';
    targetPath: string;
};
/**
 * Parses shell command strings (`run_command` / `Bash`) for Git repository, worktree, and branch
 * lifecycle operations (`worktree add/remove/prune`, `switch/checkout/pull/merge/rebase/reset`, `init/clone`).
 */
export declare function extractGitLifecycleActions(commandLine: string, defaultCwd: string): GitLifecycleAction[];
/**
 * Polymorphically parses stdin JSON from either Antigravity or Claude Code hook harnesses.
 */
export declare function parseHookInput(eventTypeArg: string, rawStdinJson: string): ParsedHookInput;
/** Linked worktrees of `wsRoot` (excluding itself), capped so the hint stays small. */
export declare function listLinkedWorktrees(wsRoot: string, limit?: number): string[];
/** Short SessionStart hint: the exact CLI invocation, per-root `--workspace`, and delegation guidance. */
export declare function buildSessionHint(roots: string[]): string | null;
/**
 * Executes a hook invocation for either `session-start` or `post-tool-use` and returns
 * the harness-compatible stdout JSON response alongside timing telemetry.
 */
export declare function handleHookInvocation(eventTypeArg: string, rawStdinJson: string, options?: HookInvocationOptions): Promise<HookResult>;
//# sourceMappingURL=hook-handler.d.ts.map