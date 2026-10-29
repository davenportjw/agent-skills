import type { CompilerAdapter, CompilerGraphBatch } from '../types.js';
interface SqlStatementSpan {
    text: string;
    startLine: number;
    endLine: number;
}
export declare class SqlCompilerAdapter implements CompilerAdapter {
    readonly name = "sql-ddl";
    readonly languages: readonly ["sql"];
    supportsFile(filePath: string): boolean;
    discoverSqlFiles(workspaceRoot: string): string[];
    /**
     * Splits SQL content into top-level statements terminated by ';',
     * preserving 1-based startLine and endLine while ignoring semicolons inside:
     * - single quotes '...'
     * - double quotes "..."
     * - backticks `...`
     * - dollar-quoted blocks $$...$$ or $tag$...$tag$
     * - line comments --...
     * - block comments /* ... *\/
     * - Dataform SQLX config { ... } blocks
     */
    splitSqlStatementsWithLines(src: string): SqlStatementSpan[];
    /**
     * Splits a CREATE TABLE (...) body on top-level commas (paren depth 0),
     * preserving the relative line offset of each column or table constraint.
     */
    private splitSqlBodyItems;
    private normalizeSqlIdentifier;
    /**
     * Parses column name and full SQL type (including multi-word types like
     * `TIMESTAMP WITH TIME ZONE`, `DOUBLE PRECISION`, `ARRAY<STRING(64)>`, `NUMERIC(10, 2)`)
     * stopping at SQL column constraint keywords.
     */
    private parseColumnNameAndType;
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}
export {};
//# sourceMappingURL=sql-adapter.d.ts.map