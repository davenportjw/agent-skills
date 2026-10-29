import type { CompilerAdapter, CompilerGraphBatch } from '../types.js';
interface DockerfileLogicalLine {
    startLine: number;
    endLine: number;
    text: string;
}
export declare class DockerfileCompilerAdapter implements CompilerAdapter {
    readonly name = "dockerfile";
    readonly languages: readonly ["dockerfile"];
    supportsFile(filePath: string): boolean;
    discoverDockerfiles(workspaceRoot: string): string[];
    /**
     * Merges backslash-continued lines while preserving exact 1-based startLine and endLine.
     */
    parseLogicalLines(content: string): DockerfileLogicalLine[];
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}
export {};
//# sourceMappingURL=dockerfile-adapter.d.ts.map