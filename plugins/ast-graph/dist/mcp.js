import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeGraph, runBenchmark } from './analyzer.js';
import { assessWorkspace, canonicalizeWorkspaceRoot, computeRepoId, findEnclosingRepoRoot, getRegisteredWorkspaces, } from './assessor.js';
import { formatCompactCliOutput } from './cli.js';
import { AstGraphDatabase } from './db.js';
import { AstGraphIndexer } from './indexer.js';
/** Real path of this plugin's install root (`<root>/dist/mcp.js` or `<root>/src/mcp.ts` -> `<root>`). */
export const PLUGIN_ROOT = canonicalizeWorkspaceRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
/**
 * True when `dir` is a plugin installation location rather than a user workspace: this plugin's own
 * root (or any directory inside it), or a harness plugin cache (~/.gemini/config/plugins, ~/.claude/plugins).
 * MCP hosts frequently spawn servers with cwd set to the plugin directory; that must never become the
 * default index target.
 */
export function isPluginInstallDir(dir, pluginRoot = PLUGIN_ROOT) {
    const real = canonicalizeWorkspaceRoot(dir);
    const within = (root) => real === root || real.startsWith(`${root}${path.sep}`);
    if (within(pluginRoot))
        return true;
    const home = os.homedir();
    const caches = [
        path.join(home, '.gemini', 'config', 'plugins'),
        path.join(home, '.claude', 'plugins'),
        path.join(home, '.codex', 'plugins'),
    ];
    return caches.some((c) => within(path.resolve(c)) || within(canonicalizeWorkspaceRoot(c)));
}
const WORKSPACE_PARAM_SCHEMA = {
    type: 'string',
    description: 'Optional workspace directory path or repository name (e.g., "/Users/.../electric-sheep" or "electric-sheep"). Auto-resolves to the enclosing git repository and its isolated <repo>/.ast-graph/ast.db.',
};
function cleanFilePathToken(raw) {
    return raw
        .trim()
        .replace(/^file:\/\//i, '')
        .replace(/#L?\d+(?:-L?\d+)?$/i, '');
}
function splitSymbolString(raw, preservePhrases = false) {
    const trimmed = raw.trim();
    if (!trimmed)
        return [];
    if (trimmed.startsWith('scip-') ||
        /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\/\S*$/i.test(trimmed)) {
        return [trimmed];
    }
    if (preservePhrases && !trimmed.includes(',')) {
        return [trimmed];
    }
    return trimmed
        .split(preservePhrases ? /[,]+/ : /[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}
/**
 * Canonical input coercion pipeline for all AST GraphDB MCP tools.
 * Normalizes singular/plural and cross-tool parameter aliases (`filePath`/`filePaths`/`files`/`path`,
 * `query`/`queries`/`target`/`targets`/`symbol`/`symbols`/`name`/`names`, `from`/`src`, `to`/`dst`)
 * so lazy-loaded tool calls never fail or return empty due to parameter naming drift.
 */
export function normalizeMcpToolArgs(toolName, rawArgs) {
    const collectStrings = (keys, splitMode) => {
        const out = [];
        for (const k of keys) {
            const val = rawArgs[k];
            if (Array.isArray(val)) {
                for (const item of val) {
                    if (typeof item === 'string' && item.trim()) {
                        out.push(splitMode === 'file' ? cleanFilePathToken(item) : item.trim());
                    }
                }
            }
            else if (typeof val === 'string' && val.trim()) {
                if (splitMode === 'file') {
                    const parts = val.includes(',')
                        ? val.split(',').map((p) => cleanFilePathToken(p))
                        : [cleanFilePathToken(val)];
                    out.push(...parts.filter(Boolean));
                }
                else {
                    out.push(...splitSymbolString(val, splitMode === 'phrase'));
                }
            }
        }
        return [...new Set(out.filter(Boolean))];
    };
    const fileAliasKeys = toolName === 'ast_outline' || toolName === 'ast_sync'
        ? [
            'filePaths',
            'filePath',
            'files',
            'file',
            'paths',
            'path',
            'uris',
            'uri',
            'targets',
            'target',
            'queries',
            'query',
        ]
        : ['filePaths', 'filePath', 'files', 'file', 'paths', 'path', 'uris', 'uri'];
    const symbolAliasKeys = [
        'queries',
        'query',
        'targets',
        'target',
        'symbols',
        'symbol',
        'names',
        'name',
        'nodes',
        'node',
        'filePaths',
        'filePath',
        'files',
        'file',
        'paths',
        'path',
    ];
    const filePaths = collectStrings(fileAliasKeys, 'file');
    const symbolTargets = collectStrings(symbolAliasKeys, toolName === 'ast_search' ? 'phrase' : 'symbol');
    const fromCandidates = collectStrings(['from', 'src', 'source', 'start', 'fromSymbol', 'fromTarget'], 'phrase');
    const toCandidates = collectStrings(['to', 'dst', 'dest', 'destination', 'end', 'toSymbol', 'toTarget', 'target'], 'phrase');
    let fromTarget = fromCandidates[0] ?? '';
    let toTarget = toCandidates[0] ?? '';
    if ((!fromTarget || !toTarget) && symbolTargets.length >= 2) {
        fromTarget = fromTarget || symbolTargets[0];
        toTarget = toTarget || symbolTargets[1];
    }
    return {
        filePaths,
        symbolTargets,
        fromTarget,
        toTarget,
    };
}
export const MCP_TOOLS_MANIFEST = [
    {
        name: 'ast_assess',
        description: 'Inspect a project workspace to detect languages, frameworks, test runners, package roots, and initialize/verify its isolated <repo>/.ast-graph/manifest.json and .git/info/exclude.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
        },
    },
    {
        name: 'ast_symbol',
        description: 'Look up one or more symbol definitions, signatures, docstrings, callers, callees, type references, and covering tests in the AST GraphDB.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Symbol name, qualified name, SCIP URI, or space/comma-separated list of symbols',
                },
                queries: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional batch array of symbol queries to resolve in a single call',
                },
                kind: {
                    type: 'string',
                    description: 'Optional NodeKind filter (Function, Class, Property, ZodSchema, RouteEndpoint, etc.)',
                },
                limit: { type: 'number', description: 'Maximum callers/callees/tests to return (default: 20)' },
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
            required: ['query'],
        },
    },
    {
        name: 'ast_refs',
        description: 'Locate all exact WRITES_PROPERTY (assignment/mutation sites), READS_PROPERTY (read sites), and general references for one or more class/struct fields, interface properties, schemas, or symbols.',
        inputSchema: {
            type: 'object',
            properties: {
                target: {
                    type: 'string',
                    description: 'Property/field name, qualified name, or SCIP URI',
                },
                targets: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional batch array of property/symbol targets to inspect in a single call',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum read/write references to return per category (default: 25)',
                },
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
            required: ['target'],
        },
    },
    {
        name: 'ast_outline',
        description: 'List a structural symbol table / outline of one or more source files with exact startLine-endLine ranges and signatures. Use instead of chunked view_file reads on large files.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Workspace-relative or absolute file path',
                },
                filePaths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional batch array of file paths to outline in a single call',
                },
                filter: {
                    type: 'string',
                    description: 'Optional case-insensitive substring filter on symbol name or signature',
                },
                kind: {
                    type: 'string',
                    description: 'Optional NodeKind filter (Function, Class, Property, Interface, TypeAlias, Variable, ZodSchema)',
                },
                exportedOnly: { type: 'boolean', description: 'Only return exported symbols (default: false)' },
                limit: { type: 'number', description: 'Maximum symbols to return (default: 40; output is capped at ~3.8KB inline)' },
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
            required: ['filePath'],
        },
    },
    {
        name: 'ast_search',
        description: 'Fuzzy FTS5/substring search across all indexed symbols by name, qualified name, or signature without false-positive SCIP URI path matches.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Symbol search query' },
                kind: {
                    type: 'string',
                    description: 'Optional NodeKind filter (Function, Class, Property, ZodSchema, RouteEndpoint, etc.)',
                },
                limit: { type: 'number', description: 'Maximum matches to return (default: 15; output is capped at ~3.8KB inline)' },
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
            required: ['query'],
        },
    },
    {
        name: 'ast_blast_radius',
        description: 'Compute the k-hop upstream blast radius of modifying a symbol or file, returning impacted symbols by hop, impacted packages, and minimal covering test files.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'Symbol name, SCIP URI, or file path' },
                maxHops: { type: 'number', description: 'Maximum upstream traversal hops (default: 3)' },
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
            required: ['target'],
        },
    },
    {
        name: 'ast_tests_for',
        description: 'Find direct and transitive TestSuite and TestCase blocks covering a symbol or source file, plus the exact language-aware test runner command (vitest / uv run pytest / go test).',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'Symbol name, SCIP URI, or file path' },
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
            required: ['target'],
        },
    },
    {
        name: 'ast_lineage',
        description: 'Trace end-to-end cross-layer lineage for a Zod/Pydantic/Go/SQL schema, Fastify/FastAPI/Flask/Go/HTMX route, or Terraform Cloud Run resource.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'Schema name, route endpoint, SQL table, or Terraform resource' },
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
            required: ['target'],
        },
    },
    {
        name: 'ast_shortest_path',
        description: 'Find the shortest AST dependency chain (calls, references, imports) between any two symbols or files.',
        inputSchema: {
            type: 'object',
            properties: {
                from: { type: 'string', description: 'Source symbol or file' },
                to: { type: 'string', description: 'Destination symbol or file' },
                maxHops: { type: 'number', description: 'Maximum hops (default: 6)' },
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
            required: ['from', 'to'],
        },
    },
    {
        name: 'ast_analyze',
        description: 'Run structural health analysis over the AST GraphDB: package coupling/instability (Ca, Ce, I), high-fan-in untested hubs, dead exports, and circular dependencies.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
        },
    },
    {
        name: 'ast_benchmark',
        description: 'Run the empirical indexing, query latency, and traceability token-efficiency benchmark suite across the workspace.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
        },
    },
    {
        name: 'ast_sync',
        description: 'Trigger an immediate incremental or full AST GraphDB synchronization across TypeScript/JS, Python, Go/Templ, Terraform, and SQL adapters.',
        inputSchema: {
            type: 'object',
            properties: {
                full: { type: 'boolean', description: 'Force full re-index (default: false)' },
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional list of file paths to incrementally re-index',
                },
                workspace: WORKSPACE_PARAM_SCHEMA,
            },
        },
    },
];
export class AstMcpServer {
    /** Directory the server was launched for (cwd / --workspace / AST_GRAPH_WORKSPACE). */
    workspaceRoot;
    /**
     * Default workspace used when a tool call does not name one. `null` when the launch directory is a
     * plugin install dir; in that case MCP client roots (`roots/list`) or explicit `workspace` args are required.
     */
    defaultWorkspaceRoot;
    explicitDbPath;
    pool = new Map();
    clientRoots = [];
    clientSupportsRoots = false;
    nextOutboundId = 1;
    pendingOutbound = new Map();
    /** Sink for server-initiated JSON-RPC messages (requests to the client). Set by the stdio loop. */
    sendToClient = null;
    constructor(workspaceRoot, dbPath) {
        this.workspaceRoot = canonicalizeWorkspaceRoot(workspaceRoot);
        this.explicitDbPath = dbPath;
        this.defaultWorkspaceRoot =
            dbPath || !isPluginInstallDir(this.workspaceRoot) ? this.workspaceRoot : null;
        if (this.defaultWorkspaceRoot) {
            this.getOrOpenWorkspace(this.defaultWorkspaceRoot, dbPath);
        }
    }
    requireDefaultHandle() {
        const root = this.clientRoots.length === 1 ? this.clientRoots[0] : this.defaultWorkspaceRoot;
        if (!root) {
            throw new Error(this.noWorkspaceMessage());
        }
        return this.getOrOpenWorkspace(root, root === this.defaultWorkspaceRoot ? this.explicitDbPath : undefined);
    }
    /** Default workspace database (throws NO_WORKSPACE when launched from a plugin install dir without client roots). */
    get db() {
        return this.requireDefaultHandle().db;
    }
    get indexer() {
        return this.requireDefaultHandle().indexer;
    }
    /** Workspace roots reported by the MCP client via `roots/list` (canonical repo roots). */
    getClientRoots() {
        return [...this.clientRoots];
    }
    setClientRoots(uris) {
        const roots = [];
        for (const uri of uris) {
            try {
                const p = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
                if (!fs.existsSync(p) || isPluginInstallDir(p))
                    continue;
                const root = findEnclosingRepoRoot(p) ?? canonicalizeWorkspaceRoot(p);
                if (!roots.includes(root))
                    roots.push(root);
            }
            catch {
                // Ignore malformed root URIs
            }
        }
        this.clientRoots = roots;
    }
    requestClientRoots() {
        if (!this.clientSupportsRoots || !this.sendToClient)
            return;
        const id = `ast-graph-roots-${this.nextOutboundId++}`;
        this.pendingOutbound.set(id, (result) => {
            const list = result?.roots ?? [];
            this.setClientRoots(list.map((r) => String(r.uri ?? '')).filter(Boolean));
        });
        this.sendToClient({ jsonrpc: '2.0', id, method: 'roots/list' });
    }
    noWorkspaceMessage() {
        const known = new Set();
        for (const reg of getRegisteredWorkspaces()) {
            if (!isPluginInstallDir(reg.canonicalRoot))
                known.add(reg.canonicalRoot);
        }
        for (const key of this.pool.keys())
            known.add(key.split('::')[0]);
        const list = [...known].slice(0, 12).map((r) => `  - ${path.basename(r)}  (${r})`).join('\n');
        return (`NO_WORKSPACE: could not infer which repository to query. The MCP server was launched from a plugin ` +
            `install directory (${this.workspaceRoot}) and the client reported no workspace roots. ` +
            `Pass \`workspace: "<repo-name-or-absolute-path>"\` (or an absolute file path).` +
            (list ? `\nKnown repositories:\n${list}` : '\nNo repositories are registered yet; pass an absolute path to index one.'));
    }
    getOrOpenWorkspace(rawWorkspace, explicitDbPath) {
        const repoRoot = findEnclosingRepoRoot(rawWorkspace) ?? canonicalizeWorkspaceRoot(rawWorkspace);
        const key = explicitDbPath ? `${repoRoot}::${explicitDbPath}` : repoRoot;
        const existing = this.pool.get(key);
        if (existing) {
            return existing;
        }
        const resolvedDb = explicitDbPath ?? path.join(repoRoot, '.ast-graph', 'ast.db');
        const db = new AstGraphDatabase(resolvedDb);
        const indexer = new AstGraphIndexer(repoRoot, db);
        const handle = {
            workspaceRoot: repoRoot,
            repoId: computeRepoId(repoRoot),
            db,
            indexer,
        };
        this.pool.set(key, handle);
        return handle;
    }
    getCandidateWorkspaceRoots() {
        const candidates = [];
        const seen = new Set();
        const addCandidate = (dir) => {
            if (!dir)
                return;
            try {
                const repoRoot = findEnclosingRepoRoot(dir) ?? canonicalizeWorkspaceRoot(dir);
                if (!seen.has(repoRoot) && fs.existsSync(repoRoot)) {
                    seen.add(repoRoot);
                    candidates.push(repoRoot);
                }
            }
            catch {
                // Ignore invalid paths
            }
        };
        const isDefaultPluginDir = this.defaultWorkspaceRoot === null;
        for (const root of this.clientRoots) {
            addCandidate(root);
        }
        if (!isDefaultPluginDir) {
            addCandidate(this.workspaceRoot);
        }
        for (const key of this.pool.keys()) {
            const rootPart = key.split('::')[0];
            if (rootPart && !isPluginInstallDir(rootPart)) {
                addCandidate(rootPart);
            }
        }
        for (const reg of getRegisteredWorkspaces()) {
            if (!isPluginInstallDir(reg.canonicalRoot)) {
                addCandidate(reg.canonicalRoot);
            }
        }
        const githubDir = path.join(os.homedir(), 'GitHub');
        if (fs.existsSync(githubDir)) {
            try {
                for (const entry of fs.readdirSync(githubDir, { withFileTypes: true })) {
                    if (entry.isDirectory()) {
                        const full = path.join(githubDir, entry.name);
                        if (fs.existsSync(path.join(full, '.ast-graph', 'ast.db'))) {
                            addCandidate(full);
                        }
                    }
                }
            }
            catch {
                // Ignore directory scan errors
            }
        }
        if (!isDefaultPluginDir) {
            addCandidate(this.workspaceRoot);
        }
        return candidates;
    }
    resolveWorkspaceHandle(args, toolName = '') {
        const wsArg = typeof args.workspace === 'string' ? args.workspace.trim() : '';
        if (wsArg) {
            if (fs.existsSync(wsArg)) {
                return this.getOrOpenWorkspace(wsArg);
            }
            const relCandidate = path.resolve(this.workspaceRoot, wsArg);
            if (fs.existsSync(relCandidate)) {
                return this.getOrOpenWorkspace(relCandidate);
            }
            const siblingCandidate = path.resolve(path.dirname(this.workspaceRoot), wsArg);
            if (fs.existsSync(siblingCandidate)) {
                return this.getOrOpenWorkspace(siblingCandidate);
            }
            const registered = getRegisteredWorkspaces();
            const matched = registered.find((r) => r.repoName.toLowerCase() === wsArg.toLowerCase() ||
                r.canonicalRoot.toLowerCase().endsWith(`/${wsArg.toLowerCase()}`));
            if (matched && fs.existsSync(matched.canonicalRoot)) {
                return this.getOrOpenWorkspace(matched.canonicalRoot);
            }
            const clientMatch = this.clientRoots.find((r) => path.basename(r).toLowerCase() === wsArg.toLowerCase());
            if (clientMatch) {
                return this.getOrOpenWorkspace(clientMatch);
            }
            throw new Error(`UNKNOWN_WORKSPACE: "${wsArg}" is not an existing path or a registered repository name.\n` +
                this.noWorkspaceMessage().split('\n').slice(1).join('\n'));
        }
        const norm = normalizeMcpToolArgs(toolName, args);
        const pathCandidates = [
            ...norm.filePaths,
            ...norm.symbolTargets,
            norm.fromTarget,
            norm.toTarget,
        ].filter(Boolean);
        // 1. Absolute path inside a repository
        for (const val of pathCandidates) {
            if (path.isAbsolute(val) && fs.existsSync(val)) {
                return this.getOrOpenWorkspace(val);
            }
        }
        const candidateRoots = this.getCandidateWorkspaceRoots();
        // 2. Relative file path or filename across candidate repositories
        for (const val of pathCandidates) {
            const cleaned = val.replace(/\\/g, '/').replace(/^\.\//, '');
            const looksLikePath = toolName === 'ast_outline' ||
                cleaned.includes('/') ||
                /\.(ts|tsx|js|jsx|mjs|py|go|templ|tf|sql|html|htm|jinja|jinja2|css|md|json|yaml|yml|toml)$/i.test(cleaned);
            if (!looksLikePath)
                continue;
            for (const root of candidateRoots) {
                const joined = path.resolve(root, cleaned);
                if (fs.existsSync(joined) && fs.statSync(joined).isFile()) {
                    return this.getOrOpenWorkspace(root);
                }
            }
            for (const root of candidateRoots) {
                if (!fs.existsSync(path.join(root, '.ast-graph', 'ast.db')))
                    continue;
                const handle = this.getOrOpenWorkspace(root);
                const outline = handle.db.getFileOutline(cleaned, { limit: 1 });
                if (outline.filePath) {
                    return handle;
                }
            }
        }
        // 3. Symbol / route / schema query across candidate repositories when workspace is omitted.
        //    Candidates are ordered client roots -> launch dir -> pool -> registry, so the default wins ties.
        //    The default index is synced first so an empty (new or schema-rebuilt) index never causes a
        //    false miss that silently routes the query to another repository.
        const primaryToken = norm.symbolTargets[0] ?? norm.fromTarget ?? '';
        const hasUnambiguousDefault = this.clientRoots.length === 1 || (this.clientRoots.length === 0 && this.defaultWorkspaceRoot !== null);
        if (primaryToken && candidateRoots.length > (hasUnambiguousDefault ? 1 : 0)) {
            if (hasUnambiguousDefault) {
                this.requireDefaultHandle().indexer.lazySyncIfDirty();
            }
            // First pass: exact target resolution
            for (const root of candidateRoots) {
                if (!fs.existsSync(path.join(root, '.ast-graph', 'ast.db')))
                    continue;
                const handle = this.getOrOpenWorkspace(root);
                if (handle.db.resolveTargetSymbols(primaryToken, 1, { exactOnly: true }).length > 0) {
                    return handle;
                }
            }
            // Second pass: non-exact target or fuzzy symbol match
            for (const root of candidateRoots) {
                if (!fs.existsSync(path.join(root, '.ast-graph', 'ast.db')))
                    continue;
                const handle = this.getOrOpenWorkspace(root);
                if (handle.db.resolveTargetSymbols(primaryToken, 1).length > 0 ||
                    handle.db.searchSymbols(primaryToken, undefined, 1).length > 0) {
                    return handle;
                }
            }
        }
        if (this.clientRoots.length > 1) {
            return this.getOrOpenWorkspace(this.clientRoots[0]);
        }
        return this.requireDefaultHandle();
    }
    handleRequest(req) {
        const id = req.id ?? null;
        // Response to a server-initiated request (e.g. roots/list)
        if (!req.method) {
            const msg = req;
            if (msg.id !== undefined) {
                const resolve = this.pendingOutbound.get(msg.id);
                if (resolve) {
                    this.pendingOutbound.delete(msg.id);
                    resolve(msg.result);
                }
            }
            return null;
        }
        if (req.method === 'notifications/initialized' || req.method === 'notifications/roots/list_changed') {
            this.requestClientRoots();
            return null;
        }
        if (req.method.startsWith('notifications/')) {
            return null;
        }
        if (req.method === 'initialize') {
            const caps = (req.params?.capabilities ?? {});
            this.clientSupportsRoots = Boolean(caps.roots);
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: {},
                    },
                    serverInfo: {
                        name: 'ast-graph',
                        version: '0.2.0',
                    },
                },
            };
        }
        if (req.method === 'ping') {
            return { jsonrpc: '2.0', id, result: {} };
        }
        if (req.method === 'tools/list') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    tools: MCP_TOOLS_MANIFEST,
                },
            };
        }
        if (req.method === 'tools/call') {
            const toolName = String(req.params?.name ?? '');
            const args = (req.params?.arguments ?? {});
            try {
                const handle = this.resolveWorkspaceHandle(args, toolName);
                const { db, indexer, workspaceRoot, repoId } = handle;
                if (toolName === 'ast_assess') {
                    const manifest = assessWorkspace(workspaceRoot);
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            content: [{ type: 'text', text: JSON.stringify(manifest, null, 2) }],
                            isError: false,
                        },
                    };
                }
                const norm = normalizeMcpToolArgs(toolName, args);
                // Lazy mtime check before any query tool (target-scoped for single-file ast_outline)
                if (toolName !== 'ast_sync' && toolName !== 'ast_benchmark') {
                    const outlineHint = toolName === 'ast_outline' && norm.filePaths.length === 1
                        ? norm.filePaths[0]
                        : undefined;
                    indexer.lazySyncIfDirty(outlineHint ? { targetFileHint: outlineHint } : undefined);
                }
                let payload;
                switch (toolName) {
                    case 'ast_symbol': {
                        const queries = norm.symbolTargets.length > 0 ? norm.symbolTargets : [''];
                        const kind = args.kind ? String(args.kind) : undefined;
                        const limit = args.limit !== undefined ? Number(args.limit) : 20;
                        const resolveOne = (q) => {
                            if (kind) {
                                const matches = db.searchSymbols(q, kind, limit);
                                const didYouMean = matches.length === 0 ? db.suggestClosestSymbols(q, 5) : undefined;
                                return { query: q, kind, matches, ...(didYouMean ? { didYouMean } : {}) };
                            }
                            const res = db.getSymbolNeighborhood(q, { limit });
                            if (!res.symbol && res.matches.length === 0) {
                                return { ...res, matches: db.suggestClosestSymbols(q, 5) };
                            }
                            return res;
                        };
                        if (queries.length > 1) {
                            payload = {
                                workspaceRoot,
                                repoId,
                                count: queries.length,
                                batchCount: queries.length,
                                results: queries.map(resolveOne),
                            };
                        }
                        else {
                            payload = { workspaceRoot, repoId, ...resolveOne(queries[0] ?? '') };
                        }
                        break;
                    }
                    case 'ast_refs': {
                        const targets = norm.symbolTargets.length > 0 ? norm.symbolTargets : [''];
                        const limit = args.limit !== undefined ? Number(args.limit) : 25;
                        const resolveOne = (t) => {
                            const res = db.getSymbolReferences(t, { limit });
                            const didYouMean = res.resolvedSymbols.length === 0 ? db.suggestClosestSymbols(t, 5) : undefined;
                            return { ...res, ...(didYouMean ? { didYouMean } : {}) };
                        };
                        if (targets.length > 1) {
                            payload = {
                                workspaceRoot,
                                repoId,
                                count: targets.length,
                                batchCount: targets.length,
                                results: targets.map(resolveOne),
                            };
                        }
                        else {
                            payload = {
                                workspaceRoot,
                                repoId,
                                ...resolveOne(targets[0] ?? ''),
                            };
                        }
                        break;
                    }
                    case 'ast_outline': {
                        const filePaths = norm.filePaths.length > 0 ? norm.filePaths : [''];
                        const filter = args.filter ? String(args.filter) : undefined;
                        const kind = args.kind ? String(args.kind) : undefined;
                        const exportedOnly = Boolean(args.exportedOnly);
                        const limit = args.limit !== undefined ? Number(args.limit) : 40;
                        if (filePaths.length > 1) {
                            payload = {
                                workspaceRoot,
                                repoId,
                                count: filePaths.length,
                                batchCount: filePaths.length,
                                outlines: filePaths.map((fp) => db.getFileOutline(fp, { filter, kind, exportedOnly, limit })),
                            };
                        }
                        else {
                            payload = {
                                workspaceRoot,
                                repoId,
                                ...db.getFileOutline(filePaths[0] ?? '', {
                                    filter,
                                    kind,
                                    exportedOnly,
                                    limit,
                                }),
                            };
                        }
                        break;
                    }
                    case 'ast_search': {
                        const queries = norm.symbolTargets.length > 0 ? norm.symbolTargets : [''];
                        const kind = args.kind ? String(args.kind) : undefined;
                        const limit = args.limit !== undefined ? Number(args.limit) : 15;
                        const searchOne = (q) => {
                            const matches = db.searchSymbols(q, kind, limit);
                            const didYouMean = matches.length === 0 && q.trim() ? db.suggestClosestSymbols(q, 5) : undefined;
                            return {
                                query: q,
                                kind,
                                count: matches.length,
                                matches,
                                ...(didYouMean ? { didYouMean } : {}),
                                ...(matches.length === 0 && kind ? { availableKinds: db.listKindCounts() } : {}),
                            };
                        };
                        if (queries.length > 1) {
                            payload = {
                                workspaceRoot,
                                repoId,
                                count: queries.length,
                                batchCount: queries.length,
                                results: queries.map(searchOne),
                            };
                        }
                        else {
                            payload = { workspaceRoot, repoId, ...searchOne(queries[0] ?? '') };
                        }
                        break;
                    }
                    case 'ast_blast_radius': {
                        const targets = norm.symbolTargets.length > 0 ? norm.symbolTargets : [''];
                        const maxHops = args.maxHops !== undefined ? Number(args.maxHops) : 3;
                        const runOne = (t) => {
                            const res = db.getBlastRadius(t, maxHops);
                            const didYouMean = res.resolvedSymbols.length === 0 ? db.suggestClosestSymbols(t, 5) : undefined;
                            return { ...res, ...(didYouMean ? { didYouMean } : {}) };
                        };
                        if (targets.length > 1) {
                            payload = {
                                workspaceRoot,
                                repoId,
                                count: targets.length,
                                batchCount: targets.length,
                                results: targets.map(runOne),
                            };
                        }
                        else {
                            payload = { workspaceRoot, repoId, ...runOne(targets[0] ?? '') };
                        }
                        break;
                    }
                    case 'ast_tests_for': {
                        const targets = norm.symbolTargets.length > 0 ? norm.symbolTargets : [''];
                        const runOne = (t) => {
                            const res = db.getTestsForChange(t);
                            const didYouMean = res.resolvedSymbols.length === 0 ? db.suggestClosestSymbols(t, 5) : undefined;
                            return { ...res, ...(didYouMean ? { didYouMean } : {}) };
                        };
                        if (targets.length > 1) {
                            payload = {
                                workspaceRoot,
                                repoId,
                                count: targets.length,
                                batchCount: targets.length,
                                results: targets.map(runOne),
                            };
                        }
                        else {
                            payload = { workspaceRoot, repoId, ...runOne(targets[0] ?? '') };
                        }
                        break;
                    }
                    case 'ast_lineage': {
                        const targets = norm.symbolTargets.length > 0 ? norm.symbolTargets : [''];
                        const runOne = (t) => {
                            const res = db.getCrossLayerLineage(t);
                            const didYouMean = res.focalNodes.length === 0 ? db.suggestClosestSymbols(t, 5) : undefined;
                            return { ...res, ...(didYouMean ? { didYouMean } : {}) };
                        };
                        if (targets.length > 1) {
                            payload = {
                                workspaceRoot,
                                repoId,
                                count: targets.length,
                                batchCount: targets.length,
                                results: targets.map(runOne),
                            };
                        }
                        else {
                            payload = { workspaceRoot, repoId, ...runOne(targets[0] ?? '') };
                        }
                        break;
                    }
                    case 'ast_shortest_path': {
                        const from = norm.fromTarget;
                        const to = norm.toTarget;
                        const maxHops = args.maxHops !== undefined ? Number(args.maxHops) : 6;
                        payload = { workspaceRoot, repoId, ...db.findShortestPath(from, to, maxHops) };
                        break;
                    }
                    case 'ast_analyze': {
                        payload = { workspaceRoot, repoId, ...analyzeGraph(db) };
                        break;
                    }
                    case 'ast_benchmark': {
                        payload = { workspaceRoot, repoId, ...runBenchmark(workspaceRoot, db, indexer) };
                        break;
                    }
                    case 'ast_sync': {
                        const full = Boolean(args.full);
                        const paths = norm.filePaths.length > 0 ? norm.filePaths : undefined;
                        payload = {
                            workspaceRoot,
                            repoId,
                            ...indexer.syncWorkspace({
                                full,
                                targetPaths: paths,
                                exportSnapshots: full,
                            }),
                        };
                        break;
                    }
                    default:
                        return {
                            jsonrpc: '2.0',
                            id,
                            error: {
                                code: -32601,
                                message: `Unknown MCP tool: ${toolName}`,
                            },
                        };
                }
                const toolToCliCommand = {
                    ast_symbol: 'symbol',
                    ast_refs: 'refs',
                    ast_outline: 'outline',
                    ast_search: 'search',
                    ast_blast_radius: 'blast-radius',
                    ast_tests_for: 'tests-for',
                    ast_lineage: 'lineage',
                    ast_shortest_path: 'path',
                };
                const cliCmd = toolToCliCommand[toolName];
                const rawJsonRequested = Boolean(args.rawJson) || args.format === 'json';
                const primaryLabel = String(args.query ?? args.filePath ?? args.target ?? args.from ?? '');
                const formattedText = cliCmd && !rawJsonRequested
                    ? formatCompactCliOutput(cliCmd, payload, primaryLabel)
                    : JSON.stringify(payload, null, 2);
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [
                            {
                                type: 'text',
                                text: formattedText,
                            },
                        ],
                        structuredContent: payload,
                        isError: false,
                    },
                };
            }
            catch (err) {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: err instanceof Error ? err.message : String(err),
                                }),
                            },
                        ],
                        isError: true,
                    },
                };
            }
        }
        return {
            jsonrpc: '2.0',
            id,
            error: {
                code: -32601,
                message: `Method not found: ${req.method}`,
            },
        };
    }
    close() {
        for (const handle of this.pool.values()) {
            try {
                handle.db.close();
            }
            catch {
                // Ignore close errors
            }
        }
        this.pool.clear();
    }
}
const isMain = process.argv[1] &&
    (process.argv[1].endsWith('/mcp.js') || process.argv[1].endsWith('/mcp.ts'));
if (isMain) {
    let workspaceRoot = process.env.AST_GRAPH_WORKSPACE ?? process.cwd();
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--workspace' && args[i + 1]) {
            workspaceRoot = args[i + 1];
            i++;
        }
    }
    const mcp = new AstMcpServer(workspaceRoot);
    mcp.sendToClient = (msg) => {
        process.stdout.write(JSON.stringify(msg) + '\n');
    };
    // Warm up index asynchronously after startup, only for a real (non-plugin) launch workspace
    setImmediate(() => {
        try {
            if (mcp.defaultWorkspaceRoot && fs.existsSync(path.join(mcp.defaultWorkspaceRoot, '.git'))) {
                mcp.indexer.lazySyncIfDirty();
            }
        }
        catch {
            // Ignore initial warm-up errors
        }
    });
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buffer += chunk;
        while (true) {
            const newlineIdx = buffer.indexOf('\n');
            if (newlineIdx === -1)
                break;
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line || line.startsWith('Content-Length:'))
                continue;
            try {
                const req = JSON.parse(line);
                const resp = mcp.handleRequest(req);
                if (resp) {
                    process.stdout.write(JSON.stringify(resp) + '\n');
                }
            }
            catch {
                // Ignore unparseable lines
            }
        }
    });
    process.stdin.on('end', () => {
        mcp.close();
        process.exit(0);
    });
}
//# sourceMappingURL=mcp.js.map