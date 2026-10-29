import type { CompilerAdapter, CompilerGraphBatch } from '../types.js';
/**
 * Counts `{` and `}` delimiters on a single HCL line while ignoring:
 * - `#` and `//` line comments
 * - `/* ... *\/` multi-line block comments
 * - `<<EOF` and `<<-EOF` multi-line heredocs
 * - `"..."` double-quoted strings with `\"` escapes
 */
export declare function countHclDelimsLine(line: string, inBlockComment: boolean, heredocMarker: string): {
    braceDelta: number;
    inBlockComment: boolean;
    heredocMarker: string;
};
export declare class TerraformCompilerAdapter implements CompilerAdapter {
    readonly name = "terraform";
    readonly languages: readonly ["terraform"];
    supportsFile(filePath: string): boolean;
    discoverTfFiles(workspaceRoot: string): string[];
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}
//# sourceMappingURL=terraform-adapter.d.ts.map