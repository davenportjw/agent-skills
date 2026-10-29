export interface CliExecutionOptions {
    workspaceRoot?: string;
    dbPath?: string;
    useDaemon?: boolean;
    daemonHost?: string;
    daemonPort?: number;
}
/**
 * Marker that separates the actionable summary block from detail lines. Formatters emit it
 * near the end; {@link moveSummaryFirst} hoists it directly under the header line so that
 * truncation only ever drops detail lines, never the summary.
 */
export declare const SUMMARY_MARKER = "=== TARGET SUMMARY ===";
/**
 * Inline byte budget for MCP/CLI text. Agent harnesses spill tool output above ~5 KB to a
 * file and show the model only the file path (observed in 35% of historical ast_* calls),
 * forcing an extra read round trip. Staying under this budget keeps results inline.
 */
export declare const INLINE_BYTE_BUDGET = 3800;
/** Hoist the trailing summary block directly beneath the first (header) line. */
export declare function moveSummaryFirst(text: string): string;
export interface InlineCapOptions {
    /** Absolute path where the untruncated text was saved (tee), surfaced in the footer. */
    fullOutputPath?: string;
}
/**
 * Truncate whole lines from the bottom until the text fits `maxBytes`. Because summaries are
 * hoisted first, only detail lines are dropped. The footer tells the agent how to narrow the
 * query and where the full output lives (tee pattern, as popularized by rtk).
 */
export declare function enforceInlineSizeCap(text: string, maxBytes?: number, options?: InlineCapOptions): string;
export interface CompactFormatOptions {
    /** Override the inline byte budget (default {@link INLINE_BYTE_BUDGET}). */
    maxBytes?: number;
    /** Disable writing the untruncated output to `.ast-graph/last/` (default: enabled). */
    tee?: boolean;
}
/**
 * Render a compact, summary-first, byte-budgeted text view of an AST query payload for
 * agents (MCP `content[0].text` and CLI stdout).
 */
export declare function formatCompactCliOutput(command: string, data: unknown, queryArg?: string, options?: CompactFormatOptions): string;
export declare function executeCliCommand(rawArgs: string[], options?: CliExecutionOptions): Promise<{
    exitCode: number;
    output: string;
    data: unknown;
}>;
//# sourceMappingURL=cli.d.ts.map