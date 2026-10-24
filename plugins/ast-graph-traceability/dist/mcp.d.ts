import { AstGraphDatabase } from './db.js';
import { AstGraphIndexer } from './indexer.js';
export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: {
        code: number;
        message: string;
    };
}
export declare const MCP_TOOLS_MANIFEST: readonly [{
    readonly name: "ast_symbol";
    readonly description: "Look up one or more symbol definitions, signatures, JSDoc, callers, callees, type references, and covering Vitest tests in the AST GraphDB.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly query: {
                readonly type: "string";
                readonly description: "Symbol name, qualified name, SCIP URI, or space/comma-separated list of symbols";
            };
            readonly queries: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Optional batch array of symbol queries to resolve in a single call";
            };
            readonly kind: {
                readonly type: "string";
                readonly description: "Optional NodeKind filter (Function, Class, Property, ZodSchema, RouteEndpoint, etc.)";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum callers/callees/tests to return (default: 20)";
            };
        };
        readonly required: readonly ["query"];
    };
}, {
    readonly name: "ast_refs";
    readonly description: "Locate all exact WRITES_PROPERTY (assignment/mutation sites), READS_PROPERTY (read sites), and general references for one or more class fields, interface properties, ZodSchema fields, or symbols.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly target: {
                readonly type: "string";
                readonly description: "Property/field name (e.g., runEndsAt, depletedRunVid), qualified name (SimEngine.runEndsAt), or SCIP URI";
            };
            readonly targets: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Optional batch array of property/symbol targets to inspect in a single call";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum read/write references to return per category (default: 40)";
            };
        };
        readonly required: readonly ["target"];
    };
}, {
    readonly name: "ast_outline";
    readonly description: "List a structural symbol table / outline of one or more source files with exact startLine-endLine ranges and signatures. Use instead of chunked view_file reads on large files.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly filePath: {
                readonly type: "string";
                readonly description: "Workspace-relative or suffix file path (e.g., packages/sim/src/engine.ts)";
            };
            readonly filePaths: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Optional batch array of file paths to outline in a single call";
            };
            readonly filter: {
                readonly type: "string";
                readonly description: "Optional case-insensitive substring filter on symbol name or signature";
            };
            readonly kind: {
                readonly type: "string";
                readonly description: "Optional NodeKind filter (Function, Class, Property, Interface, TypeAlias, Variable, ZodSchema)";
            };
            readonly exportedOnly: {
                readonly type: "boolean";
                readonly description: "Only return exported symbols (default: false)";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum symbols to return (default: 80)";
            };
        };
        readonly required: readonly ["filePath"];
    };
}, {
    readonly name: "ast_search";
    readonly description: "Fuzzy FTS5/substring search across all indexed symbols by name, qualified name, or signature without false-positive SCIP URI path matches.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly query: {
                readonly type: "string";
                readonly description: "Symbol search query (e.g., interact, sanitize, SimEngine)";
            };
            readonly kind: {
                readonly type: "string";
                readonly description: "Optional NodeKind filter (Function, Class, Property, ZodSchema, RouteEndpoint, etc.)";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum matches to return (default: 25)";
            };
        };
        readonly required: readonly ["query"];
    };
}, {
    readonly name: "ast_blast_radius";
    readonly description: "Compute the k-hop upstream blast radius of modifying a symbol or file, returning impacted symbols by hop, impacted packages, and minimal covering Vitest test files.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly target: {
                readonly type: "string";
                readonly description: "Symbol name, SCIP URI, or file path";
            };
            readonly maxHops: {
                readonly type: "number";
                readonly description: "Maximum upstream traversal hops (default: 3)";
            };
        };
        readonly required: readonly ["target"];
    };
}, {
    readonly name: "ast_tests_for";
    readonly description: "Find direct and transitive Vitest TestSuite and TestCase blocks covering a symbol or source file, plus the exact npx vitest run command.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly target: {
                readonly type: "string";
                readonly description: "Symbol name, SCIP URI, or file path";
            };
        };
        readonly required: readonly ["target"];
    };
}, {
    readonly name: "ast_lineage";
    readonly description: "Trace end-to-end cross-layer lineage for a @warehouse/protocol Zod schema, Fastify HTTP/WS route, or Terraform Cloud Run resource.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly target: {
                readonly type: "string";
                readonly description: "Schema name, route endpoint, or Terraform resource";
            };
        };
        readonly required: readonly ["target"];
    };
}, {
    readonly name: "ast_shortest_path";
    readonly description: "Find the shortest AST dependency chain (calls, references, imports) between any two symbols or files.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly from: {
                readonly type: "string";
                readonly description: "Source symbol or file";
            };
            readonly to: {
                readonly type: "string";
                readonly description: "Destination symbol or file";
            };
            readonly maxHops: {
                readonly type: "number";
                readonly description: "Maximum hops (default: 6)";
            };
        };
        readonly required: readonly ["from", "to"];
    };
}, {
    readonly name: "ast_analyze";
    readonly description: "Run structural health analysis over the AST GraphDB: package coupling/instability (Ca, Ce, I), high-fan-in untested hubs, dead exports, and circular dependencies.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {};
    };
}, {
    readonly name: "ast_benchmark";
    readonly description: "Run the empirical indexing, query latency, and traceability token-efficiency benchmark suite across the workspace.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {};
    };
}, {
    readonly name: "ast_sync";
    readonly description: "Trigger an immediate incremental or full AST GraphDB synchronization across TypeScript, Terraform, and Python adapters.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly full: {
                readonly type: "boolean";
                readonly description: "Force full re-index (default: false)";
            };
            readonly paths: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Optional list of file paths to incrementally re-index";
            };
        };
    };
}];
export declare class AstMcpServer {
    workspaceRoot: string;
    db: AstGraphDatabase;
    indexer: AstGraphIndexer;
    private readonly explicitDbPath?;
    constructor(workspaceRoot: string, dbPath?: string);
    rebindWorkspaceIfNeeded(candidateRoot: string): void;
    handleRequest(req: JsonRpcRequest): JsonRpcResponse | null;
    close(): void;
}
//# sourceMappingURL=mcp.d.ts.map