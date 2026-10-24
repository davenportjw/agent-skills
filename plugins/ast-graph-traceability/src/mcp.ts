import fs from 'node:fs';
import path from 'node:path';
import { analyzeGraph, runBenchmark } from './analyzer.js';
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

export const MCP_TOOLS_MANIFEST = [
  {
    name: 'ast_symbol',
    description:
      'Look up one or more symbol definitions, signatures, JSDoc, callers, callees, type references, and covering Vitest tests in the AST GraphDB.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name, qualified name, SCIP URI, or space/comma-separated list of symbols' },
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional batch array of symbol queries to resolve in a single call',
        },
        kind: { type: 'string', description: 'Optional NodeKind filter (Function, Class, Property, ZodSchema, RouteEndpoint, etc.)' },
        limit: { type: 'number', description: 'Maximum callers/callees/tests to return (default: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ast_refs',
    description:
      'Locate all exact WRITES_PROPERTY (assignment/mutation sites), READS_PROPERTY (read sites), and general references for one or more class fields, interface properties, ZodSchema fields, or symbols.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Property/field name (e.g., runEndsAt, depletedRunVid), qualified name (SimEngine.runEndsAt), or SCIP URI' },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional batch array of property/symbol targets to inspect in a single call',
        },
        limit: { type: 'number', description: 'Maximum read/write references to return per category (default: 40)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'ast_outline',
    description:
      'List a structural symbol table / outline of one or more source files with exact startLine-endLine ranges and signatures. Use instead of chunked view_file reads on large files.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Workspace-relative or suffix file path (e.g., packages/sim/src/engine.ts)' },
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional batch array of file paths to outline in a single call',
        },
        filter: { type: 'string', description: 'Optional case-insensitive substring filter on symbol name or signature' },
        kind: { type: 'string', description: 'Optional NodeKind filter (Function, Class, Property, Interface, TypeAlias, Variable, ZodSchema)' },
        exportedOnly: { type: 'boolean', description: 'Only return exported symbols (default: false)' },
        limit: { type: 'number', description: 'Maximum symbols to return (default: 80)' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'ast_search',
    description:
      'Fuzzy FTS5/substring search across all indexed symbols by name, qualified name, or signature without false-positive SCIP URI path matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol search query (e.g., interact, sanitize, SimEngine)' },
        kind: { type: 'string', description: 'Optional NodeKind filter (Function, Class, Property, ZodSchema, RouteEndpoint, etc.)' },
        limit: { type: 'number', description: 'Maximum matches to return (default: 25)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ast_blast_radius',
    description:
      'Compute the k-hop upstream blast radius of modifying a symbol or file, returning impacted symbols by hop, impacted packages, and minimal covering Vitest test files.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Symbol name, SCIP URI, or file path' },
        maxHops: { type: 'number', description: 'Maximum upstream traversal hops (default: 3)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'ast_tests_for',
    description:
      'Find direct and transitive Vitest TestSuite and TestCase blocks covering a symbol or source file, plus the exact npx vitest run command.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Symbol name, SCIP URI, or file path' },
      },
      required: ['target'],
    },
  },
  {
    name: 'ast_lineage',
    description:
      'Trace end-to-end cross-layer lineage for a @warehouse/protocol Zod schema, Fastify HTTP/WS route, or Terraform Cloud Run resource.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Schema name, route endpoint, or Terraform resource' },
      },
      required: ['target'],
    },
  },
  {
    name: 'ast_shortest_path',
    description:
      'Find the shortest AST dependency chain (calls, references, imports) between any two symbols or files.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source symbol or file' },
        to: { type: 'string', description: 'Destination symbol or file' },
        maxHops: { type: 'number', description: 'Maximum hops (default: 6)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'ast_analyze',
    description:
      'Run structural health analysis over the AST GraphDB: package coupling/instability (Ca, Ce, I), high-fan-in untested hubs, dead exports, and circular dependencies.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ast_benchmark',
    description:
      'Run the empirical indexing, query latency, and traceability token-efficiency benchmark suite across the workspace.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ast_sync',
    description:
      'Trigger an immediate incremental or full AST GraphDB synchronization across TypeScript, Terraform, and Python adapters.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Force full re-index (default: false)' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of file paths to incrementally re-index',
        },
      },
    },
  },
] as const;

function resolveInitialWorkspaceRoot(rawRoot: string): string {
  let curr = path.resolve(rawRoot);
  while (true) {
    if (!curr.includes('/.gemini/') && fs.existsSync(path.join(curr, '.git'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(rawRoot);
}

export class AstMcpServer {
  public workspaceRoot: string;
  public db: AstGraphDatabase;
  public indexer: AstGraphIndexer;
  private readonly explicitDbPath?: string;

  constructor(workspaceRoot: string, dbPath?: string) {
    this.workspaceRoot = resolveInitialWorkspaceRoot(workspaceRoot);
    this.explicitDbPath = dbPath;
    const resolvedDb =
      dbPath ??
      process.env.AST_GRAPH_DB_PATH ??
      path.join(this.workspaceRoot, '.ast-graph', 'ast.db');
    this.db = new AstGraphDatabase(resolvedDb);
    this.indexer = new AstGraphIndexer(this.workspaceRoot, this.db);
  }

  public rebindWorkspaceIfNeeded(candidateRoot: string): void {
    const resolved = resolveInitialWorkspaceRoot(candidateRoot.replace(/^file:\/\//, ''));
    if (
      resolved &&
      resolved !== this.workspaceRoot &&
      fs.existsSync(resolved) &&
      !this.explicitDbPath
    ) {
      try {
        this.db.close();
      } catch {
        // Ignore
      }
      this.workspaceRoot = resolved;
      const nextDbPath =
        process.env.AST_GRAPH_DB_PATH && path.isAbsolute(process.env.AST_GRAPH_DB_PATH)
          ? process.env.AST_GRAPH_DB_PATH
          : path.join(this.workspaceRoot, '.ast-graph', 'ast.db');
      this.db = new AstGraphDatabase(nextDbPath);
      this.indexer = new AstGraphIndexer(this.workspaceRoot, this.db);
    }
  }

  public handleRequest(req: JsonRpcRequest): JsonRpcResponse | null {
    const id = req.id ?? null;

    if (req.method === 'notifications/initialized' || req.method.startsWith('notifications/')) {
      return null;
    }

    if (req.method === 'initialize') {
      const folders = Array.isArray(req.params?.workspaceFolders)
        ? (req.params?.workspaceFolders as Array<{ uri?: string }>)
        : [];
      const initRoot =
        (typeof folders[0]?.uri === 'string' ? folders[0].uri : undefined) ??
        (typeof req.params?.rootUri === 'string' ? req.params.rootUri : undefined) ??
        (typeof req.params?.rootPath === 'string' ? req.params.rootPath : undefined);
      if (initRoot && this.workspaceRoot.includes('/.gemini/')) {
        this.rebindWorkspaceIfNeeded(initRoot);
      }
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'warehouse-ast-sidecar',
            version: '0.1.0',
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
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;

      try {
        // Lazy mtime check before any query tool (target-scoped for ast_outline)
        if (toolName !== 'ast_sync' && toolName !== 'ast_benchmark') {
          const outlineHint =
            toolName === 'ast_outline' && typeof args.filePath === 'string' && !Array.isArray(args.filePaths)
              ? args.filePath
              : undefined;
          this.indexer.lazySyncIfDirty(outlineHint ? { targetFileHint: outlineHint } : undefined);
        }

        let payload: unknown;
        switch (toolName) {
          case 'ast_symbol': {
            const rawQueries = Array.isArray(args.queries)
              ? args.queries.map((item) => String(item).trim()).filter(Boolean)
              : String(args.query ?? '')
                  .split(/[\s,]+/)
                  .map((s) => s.trim())
                  .filter(Boolean);
            const queries = rawQueries.length > 0 ? rawQueries : [String(args.query ?? '')];
            const kind = args.kind ? String(args.kind) : undefined;
            const limit = args.limit !== undefined ? Number(args.limit) : 20;
            if (queries.length > 1) {
              payload = {
                batchCount: queries.length,
                results: queries.map((q) =>
                  kind
                    ? { query: q, kind, matches: this.db.searchSymbols(q, kind, limit) }
                    : this.db.getSymbolNeighborhood(q, { limit }),
                ),
              };
            } else {
              const q = queries[0] ?? '';
              payload = kind
                ? { query: q, kind, matches: this.db.searchSymbols(q, kind, limit) }
                : this.db.getSymbolNeighborhood(q, { limit });
            }
            break;
          }
          case 'ast_refs': {
            const rawTargets = Array.isArray(args.targets)
              ? args.targets.map((item) => String(item).trim()).filter(Boolean)
              : String(args.target ?? args.query ?? '')
                  .split(/[\s,]+/)
                  .map((s) => s.trim())
                  .filter(Boolean);
            const targets = rawTargets.length > 0 ? rawTargets : [String(args.target ?? '')];
            const limit = args.limit !== undefined ? Number(args.limit) : 40;
            if (targets.length > 1) {
              payload = {
                batchCount: targets.length,
                results: targets.map((t) => this.db.getSymbolReferences(t, { limit })),
              };
            } else {
              payload = this.db.getSymbolReferences(targets[0] ?? '', { limit });
            }
            break;
          }
          case 'ast_outline': {
            const filePaths = Array.isArray(args.filePaths)
              ? args.filePaths.map((item) => String(item).trim()).filter(Boolean)
              : [String(args.filePath ?? '')];
            const filter = args.filter ? String(args.filter) : undefined;
            const kind = args.kind ? String(args.kind) : undefined;
            const exportedOnly = Boolean(args.exportedOnly);
            const limit = args.limit !== undefined ? Number(args.limit) : 80;
            if (filePaths.length > 1) {
              payload = {
                batchCount: filePaths.length,
                outlines: filePaths.map((fp) =>
                  this.db.getFileOutline(fp, { filter, kind, exportedOnly, limit }),
                ),
              };
            } else {
              payload = this.db.getFileOutline(filePaths[0] ?? '', {
                filter,
                kind,
                exportedOnly,
                limit,
              });
            }
            break;
          }
          case 'ast_search': {
            const q = String(args.query ?? '');
            const kind = args.kind ? String(args.kind) : undefined;
            const limit = args.limit !== undefined ? Number(args.limit) : 25;
            const matches = this.db.searchSymbols(q, kind, limit);
            payload = { query: q, kind, count: matches.length, matches };
            break;
          }
          case 'ast_blast_radius': {
            const target = String(args.target ?? '');
            const maxHops = args.maxHops !== undefined ? Number(args.maxHops) : 3;
            payload = this.db.getBlastRadius(target, maxHops);
            break;
          }
          case 'ast_tests_for': {
            const target = String(args.target ?? '');
            payload = this.db.getTestsForChange(target);
            break;
          }
          case 'ast_lineage': {
            const target = String(args.target ?? '');
            payload = this.db.getCrossLayerLineage(target);
            break;
          }
          case 'ast_shortest_path': {
            const from = String(args.from ?? '');
            const to = String(args.to ?? '');
            const maxHops = args.maxHops !== undefined ? Number(args.maxHops) : 6;
            payload = this.db.findShortestPath(from, to, maxHops);
            break;
          }
          case 'ast_analyze': {
            payload = analyzeGraph(this.db);
            break;
          }
          case 'ast_benchmark': {
            payload = runBenchmark(this.workspaceRoot, this.db, this.indexer);
            break;
          }
          case 'ast_sync': {
            const full = Boolean(args.full);
            const paths = Array.isArray(args.paths) ? (args.paths as string[]) : undefined;
            payload = this.indexer.syncWorkspace({
              full,
              targetPaths: paths,
              exportSnapshots: full,
            });
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

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(payload, null, 2),
              },
            ],
            isError: false,
          },
        };
      } catch (err) {
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

  public close(): void {
    this.db.close();
  }
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('/mcp.js') || process.argv[1].endsWith('/mcp.ts'));

if (isMain) {
  let workspaceRoot = process.env.AST_GRAPH_WORKSPACE ?? process.cwd();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      workspaceRoot = args[i + 1]!;
      i++;
    }
  }

  const mcp = new AstMcpServer(workspaceRoot);
  // Warm up index asynchronously after startup
  setImmediate(() => {
    try {
      mcp.indexer.lazySyncIfDirty();
    } catch {
      // Ignore initial warm-up errors
    }
  });

  // Also start debounced background watcher while MCP server is alive
  const watchers: fs.FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const dirtyPaths = new Set<string>();
  for (const dirName of ['packages', 'apps', 'tools', 'infra']) {
    const absDir = path.join(workspaceRoot, dirName);
    if (!fs.existsSync(absDir)) continue;
    try {
      const w = fs.watch(absDir, { recursive: true }, (_ev, filename) => {
        if (!filename) return;
        const rel = `${dirName}/${filename.split(path.sep).join('/')}`;
        if (rel.includes('/dist/') || rel.includes('node_modules')) return;
        if (rel.endsWith('.ts') || rel.endsWith('.mjs') || rel.endsWith('.tf')) {
          dirtyPaths.add(rel);
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const batch = [...dirtyPaths];
            dirtyPaths.clear();
            try {
              mcp.indexer.syncWorkspace({ full: false, targetPaths: batch });
            } catch {
              // Ignore
            }
          }, 150);
        }
      });
      watchers.push(w);
    } catch {
      // Ignore
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) break;
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line || line.startsWith('Content-Length:')) continue;
      try {
        const req = JSON.parse(line) as JsonRpcRequest;
        const resp = mcp.handleRequest(req);
        if (resp) {
          process.stdout.write(JSON.stringify(resp) + '\n');
        }
      } catch {
        // Ignore unparseable lines
      }
    }
  });

  process.stdin.on('end', () => {
    for (const w of watchers) w.close();
    mcp.close();
    process.exit(0);
  });
}
