import { AstGraphDatabase } from './db.js';
import { AstGraphIndexer } from './indexer.js';
/** Real path of this plugin's install root (`<root>/dist/mcp.js` or `<root>/src/mcp.ts` -> `<root>`). */
export declare const PLUGIN_ROOT: string;
/**
 * True when `dir` is a plugin installation location rather than a user workspace: this plugin's own
 * root (or any directory inside it), or a harness plugin cache (~/.gemini/config/plugins, ~/.claude/plugins).
 * MCP hosts frequently spawn servers with cwd set to the plugin directory; that must never become the
 * default index target.
 */
export declare function isPluginInstallDir(dir: string, pluginRoot?: string): boolean;
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
export interface NormalizedMcpToolArgs {
    filePaths: string[];
    symbolTargets: string[];
    fromTarget: string;
    toTarget: string;
}
/**
 * Canonical input coercion pipeline for all AST GraphDB MCP tools.
 * Normalizes singular/plural and cross-tool parameter aliases (`filePath`/`filePaths`/`files`/`path`,
 * `query`/`queries`/`target`/`targets`/`symbol`/`symbols`/`name`/`names`, `from`/`src`, `to`/`dst`)
 * so lazy-loaded tool calls never fail or return empty due to parameter naming drift.
 */
export declare function normalizeMcpToolArgs(toolName: string, rawArgs: Record<string, unknown>): NormalizedMcpToolArgs;
export declare const MCP_TOOLS_MANIFEST: readonly [{
    readonly name: "ast_assess";
    readonly description: "Inspect a project workspace to detect languages, frameworks, test runners, package roots, and initialize/verify its isolated <repo>/.ast-graph/manifest.json and .git/info/exclude.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
            };
        };
    };
}, {
    readonly name: "ast_symbol";
    readonly description: "Look up one or more symbol definitions, signatures, docstrings, callers, callees, type references, and covering tests in the AST GraphDB.";
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
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
            };
        };
        readonly required: readonly ["query"];
    };
}, {
    readonly name: "ast_refs";
    readonly description: "Locate all exact WRITES_PROPERTY (assignment/mutation sites), READS_PROPERTY (read sites), and general references for one or more class/struct fields, interface properties, schemas, or symbols.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly target: {
                readonly type: "string";
                readonly description: "Property/field name, qualified name, or SCIP URI";
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
                readonly description: "Maximum read/write references to return per category (default: 25)";
            };
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
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
                readonly description: "Workspace-relative or absolute file path";
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
                readonly description: "Maximum symbols to return (default: 40; output is capped at ~3.8KB inline)";
            };
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
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
                readonly description: "Symbol search query";
            };
            readonly kind: {
                readonly type: "string";
                readonly description: "Optional NodeKind filter (Function, Class, Property, ZodSchema, RouteEndpoint, etc.)";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum matches to return (default: 15; output is capped at ~3.8KB inline)";
            };
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
            };
        };
        readonly required: readonly ["query"];
    };
}, {
    readonly name: "ast_blast_radius";
    readonly description: "Compute the k-hop upstream blast radius of modifying a symbol or file, returning impacted symbols by hop, impacted packages, and minimal covering test files.";
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
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
            };
        };
        readonly required: readonly ["target"];
    };
}, {
    readonly name: "ast_tests_for";
    readonly description: "Find direct and transitive TestSuite and TestCase blocks covering a symbol or source file, plus the exact language-aware test runner command (vitest / uv run pytest / go test).";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly target: {
                readonly type: "string";
                readonly description: "Symbol name, SCIP URI, or file path";
            };
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
            };
        };
        readonly required: readonly ["target"];
    };
}, {
    readonly name: "ast_lineage";
    readonly description: "Trace end-to-end cross-layer lineage for a Zod/Pydantic/Go/SQL schema, Fastify/FastAPI/Flask/Go/HTMX route, or Terraform Cloud Run resource.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly target: {
                readonly type: "string";
                readonly description: "Schema name, route endpoint, SQL table, or Terraform resource";
            };
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
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
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
            };
        };
        readonly required: readonly ["from", "to"];
    };
}, {
    readonly name: "ast_analyze";
    readonly description: "Run structural health analysis over the AST GraphDB: package coupling/instability (Ca, Ce, I), high-fan-in untested hubs, dead exports, and circular dependencies.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
            };
        };
    };
}, {
    readonly name: "ast_benchmark";
    readonly description: "Run the empirical indexing, query latency, and traceability token-efficiency benchmark suite across the workspace.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
            };
        };
    };
}, {
    readonly name: "ast_sync";
    readonly description: "Trigger an immediate incremental or full AST GraphDB synchronization across TypeScript/JS, Python, Go/Templ, Terraform, and SQL adapters.";
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
            readonly workspace: {
                readonly type: "string";
                readonly description: "Optional workspace directory path or repository name (e.g., \"/Users/.../electric-sheep\" or \"electric-sheep\"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.";
            };
        };
    };
}];
export declare class AstMcpServer {
    /** Directory the server was launched for (cwd / --workspace / AST_GRAPH_WORKSPACE). */
    readonly workspaceRoot: string;
    /**
     * Default workspace used when a tool call does not name one. `null` when the launch directory is a
     * plugin install dir; in that case MCP client roots (`roots/list`) or explicit `workspace` args are required.
     */
    readonly defaultWorkspaceRoot: string | null;
    private readonly explicitDbPath?;
    private readonly pool;
    private clientRoots;
    private clientSupportsRoots;
    private nextOutboundId;
    private readonly pendingOutbound;
    /** Sink for server-initiated JSON-RPC messages (requests to the client). Set by the stdio loop. */
    sendToClient: ((msg: Record<string, unknown>) => void) | null;
    constructor(workspaceRoot: string, dbPath?: string);
    private requireDefaultHandle;
    /** Default workspace database (throws NO_WORKSPACE when launched from a plugin install dir without client roots). */
    get db(): AstGraphDatabase;
    get indexer(): AstGraphIndexer;
    /** Workspace roots reported by the MCP client via `roots/list` (canonical repo roots). */
    getClientRoots(): string[];
    setClientRoots(uris: string[]): void;
    private requestClientRoots;
    private noWorkspaceMessage;
    private getOrOpenWorkspace;
    private getCandidateWorkspaceRoots;
    private resolveWorkspaceHandle;
    handleRequest(req: JsonRpcRequest): JsonRpcResponse | null;
    close(): void;
}
//# sourceMappingURL=mcp.d.ts.map