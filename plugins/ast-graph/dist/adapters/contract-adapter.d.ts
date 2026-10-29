import { CompilerAdapter, CompilerGraphBatch } from '../types.js';
export declare class ContractCompilerAdapter implements CompilerAdapter {
    readonly name = "scip-contracts";
    readonly languages: readonly ["protobuf", "graphql"];
    supportsFile(filePath: string): boolean;
    discoverContractFiles(workspaceRoot: string): string[];
    /**
     * Replaces /* ... *\/ block comments with spaces while preserving exact '\n' line numbers.
     */
    private stripProtoBlockComments;
    private countProtoBraces;
    private findProtoBlockEnd;
    private tokenizeGraphQL;
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}
//# sourceMappingURL=contract-adapter.d.ts.map