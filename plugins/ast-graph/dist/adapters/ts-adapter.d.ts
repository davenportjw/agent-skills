import ts from 'typescript';
import type { CompilerAdapter, CompilerGraphBatch } from '../types.js';
interface WorkspacePkgInfo {
    name: string;
    version: string;
    relDir: string;
    absDir: string;
    entryRelPath: string;
}
/**
 * Class/interface members carry no `export` keyword, so visibility is derived from
 * access modifiers: `private`/`protected` members and ECMAScript `#private` names are
 * not part of the public surface.
 */
export declare function isPublicMember(node: ts.Node): boolean;
export declare class TypeScriptCompilerAdapter implements CompilerAdapter {
    readonly name = "typescript";
    readonly languages: readonly ["typescript", "javascript"];
    supportsFile(filePath: string): boolean;
    discoverWorkspacePackages(workspaceRoot: string): WorkspacePkgInfo[];
    discoverAllSourceFiles(workspaceRoot: string): string[];
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}
export {};
//# sourceMappingURL=ts-adapter.d.ts.map