export interface CliExecutionOptions {
    workspaceRoot?: string;
    dbPath?: string;
    useDaemon?: boolean;
    daemonHost?: string;
    daemonPort?: number;
}
export declare function enforceInlineSizeCap(text: string, maxChars?: number): string;
export declare function formatCompactCliOutput(command: string, data: unknown, queryArg?: string): string;
export declare function executeCliCommand(rawArgs: string[], options?: CliExecutionOptions): Promise<{
    exitCode: number;
    output: string;
    data: unknown;
}>;
//# sourceMappingURL=cli.d.ts.map