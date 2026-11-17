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
}
export interface ParsedHookInput {
    harness: HookHarnessFormat;
    eventType: string;
    filePath?: string;
    workspacePaths: string[];
    rawPayload: Record<string, unknown>;
}
/**
 * Polymorphically parses stdin JSON from either Antigravity or Claude Code hook harnesses.
 */
export declare function parseHookInput(eventTypeArg: string, rawStdinJson: string): ParsedHookInput;
/**
 * Executes a hook invocation for either `session-start` or `post-tool-use` and returns
 * the harness-compatible stdout JSON response alongside timing telemetry.
 */
export declare function handleHookInvocation(eventTypeArg: string, rawStdinJson: string, options?: HookInvocationOptions): Promise<HookResult>;
//# sourceMappingURL=hook-handler.d.ts.map