import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { analyzeGraph, runBenchmark } from './analyzer.js';
import { AstGraphDatabase } from './db.js';
import { AstGraphIndexer } from './indexer.js';

export interface SidecarDaemonOptions {
  workspaceRoot?: string;
  dbPath?: string;
  port?: number;
  host?: string;
  enableWatcher?: boolean;
}

export interface SidecarDaemonInstance {
  server: http.Server;
  db: AstGraphDatabase;
  indexer: AstGraphIndexer;
  port: number;
  close: () => Promise<void>;
}

export async function startSidecarDaemon(
  options: SidecarDaemonOptions = {},
): Promise<SidecarDaemonInstance> {
  const workspaceRoot = path.resolve(
    options.workspaceRoot ?? process.env.AST_GRAPH_WORKSPACE ?? process.cwd(),
  );
  const dbPath = path.resolve(
    options.dbPath ??
      process.env.AST_GRAPH_DB_PATH ??
      path.join(workspaceRoot, '.ast-graph', 'ast.db'),
  );
  const requestedPort = options.port ?? Number(process.env.AST_GRAPH_PORT ?? 4319);
  const host = options.host ?? '127.0.0.1';

  const db = new AstGraphDatabase(dbPath);
  const indexer = new AstGraphIndexer(workspaceRoot, db);

  // Initial lazy/incremental sync on startup
  const startedAtMs = Date.now();
  let lastSyncResult = indexer.lazySyncIfDirty();
  let lastSyncAt = new Date().toISOString();

  // Debounced fs.watch over packages/, apps/, tools/, infra/
  const watchers: fs.FSWatcher[] = [];
  const pendingFiles = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const flushWatchedChanges = () => {
    debounceTimer = null;
    if (pendingFiles.size === 0) return;
    const files = [...pendingFiles];
    pendingFiles.clear();
    try {
      lastSyncResult = indexer.syncWorkspace({
        full: false,
        targetPaths: files,
        exportSnapshots: false,
      });
      lastSyncAt = new Date().toISOString();
    } catch {
      // Ignore transient editor save race conditions
    }
  };

  if (options.enableWatcher !== false) {
    for (const subDir of ['packages', 'apps', 'tools', 'infra']) {
      const targetDir = path.join(workspaceRoot, subDir);
      if (!fs.existsSync(targetDir)) continue;
      try {
        const watcher = fs.watch(targetDir, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          const relPath = `${subDir}/${filename.split(path.sep).join('/')}`;
          if (
            relPath.includes('/dist/') ||
            relPath.includes('node_modules') ||
            relPath.includes('.ast-graph')
          ) {
            return;
          }
          if (
            relPath.endsWith('.ts') ||
            relPath.endsWith('.mjs') ||
            relPath.endsWith('.tf') ||
            relPath.endsWith('.py')
          ) {
            pendingFiles.add(relPath);
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(flushWatchedChanges, 150);
          }
        });
        watchers.push(watcher);
      } catch {
        // Recursive fs.watch might not be supported on some virtual filesystems
      }
    }
  }

  const sendJson = (res: http.ServerResponse, status: number, payload: unknown): void => {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  };

  const readJsonBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
      req.on('error', () => resolve({}));
    });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${requestedPort}`);
      const pathname = url.pathname;

      if (req.method === 'GET' && (pathname === '/health' || pathname === '/status')) {
        const counts = db.getCounts();
        sendJson(res, 200, {
          ok: true,
          service: '@warehouse/ast-sidecar',
          workspaceRoot,
          dbPath,
          uptimeSec: Math.round((Date.now() - startedAtMs) / 1000),
          lastSyncAt,
          lastSyncMode: lastSyncResult.mode,
          counts,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/sync') {
        const body = await readJsonBody(req);
        const full = Boolean(body.full);
        const paths = Array.isArray(body.paths) ? (body.paths as string[]) : undefined;
        lastSyncResult = indexer.syncWorkspace({
          full,
          targetPaths: paths,
          exportSnapshots: full,
        });
        lastSyncAt = new Date().toISOString();
        sendJson(res, 200, { ok: true, sync: lastSyncResult });
        return;
      }

      // Ensure lazy freshness before any query (scoped to target file for /outline)
      const outlineTargetHint =
        pathname === '/outline'
          ? (url.searchParams.get('file') ??
            url.searchParams.get('target') ??
            url.searchParams.get('q') ??
            undefined)
          : undefined;
      indexer.lazySyncIfDirty(outlineTargetHint ? { targetFileHint: outlineTargetHint } : undefined);

      if (req.method === 'GET' && pathname === '/symbol') {
        const q = url.searchParams.get('q') ?? url.searchParams.get('target') ?? '';
        const kind = url.searchParams.get('kind') ?? undefined;
        const limit = Number(url.searchParams.get('limit') ?? 20);
        if (kind) {
          const matches = db.searchSymbols(q, kind, Number.isFinite(limit) ? limit : 25);
          sendJson(res, 200, { query: q, kind, count: matches.length, matches });
        } else {
          const neighborhood = db.getSymbolNeighborhood(q, {
            limit: Number.isFinite(limit) ? limit : 20,
          });
          sendJson(res, 200, neighborhood);
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/refs') {
        const q = url.searchParams.get('q') ?? url.searchParams.get('target') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 40);
        const refs = db.getSymbolReferences(q, {
          limit: Number.isFinite(limit) ? limit : 40,
        });
        sendJson(res, 200, refs);
        return;
      }

      if (req.method === 'GET' && pathname === '/outline') {
        const file =
          url.searchParams.get('file') ??
          url.searchParams.get('target') ??
          url.searchParams.get('q') ??
          '';
        const filter = url.searchParams.get('filter') ?? undefined;
        const kind = url.searchParams.get('kind') ?? undefined;
        const exportedOnly =
          url.searchParams.get('exported') === 'true' || url.searchParams.get('exported') === '1';
        const limit = Number(url.searchParams.get('limit') ?? 250);
        const result = db.getFileOutline(file, {
          filter,
          kind,
          exportedOnly,
          limit: Number.isFinite(limit) ? limit : 250,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/search') {
        const q =
          url.searchParams.get('q') ??
          url.searchParams.get('query') ??
          url.searchParams.get('target') ??
          '';
        const kind = url.searchParams.get('kind') ?? undefined;
        const limit = Number(url.searchParams.get('limit') ?? 25);
        const matches = db.searchSymbols(q, kind, Number.isFinite(limit) ? limit : 25);
        sendJson(res, 200, { query: q, kind: kind ?? null, count: matches.length, matches });
        return;
      }

      if (req.method === 'GET' && pathname === '/blast-radius') {
        const target = url.searchParams.get('target') ?? url.searchParams.get('q') ?? '';
        const hops = Number(url.searchParams.get('hops') ?? 3);
        const result = db.getBlastRadius(target, Number.isFinite(hops) ? hops : 3);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/tests-for') {
        const target = url.searchParams.get('target') ?? url.searchParams.get('q') ?? '';
        const result = db.getTestsForChange(target);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/lineage') {
        const target = url.searchParams.get('target') ?? url.searchParams.get('q') ?? '';
        const result = db.getCrossLayerLineage(target);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/path') {
        const from = url.searchParams.get('from') ?? '';
        const to = url.searchParams.get('to') ?? '';
        const hops = Number(url.searchParams.get('hops') ?? 6);
        const result = db.findShortestPath(from, to, Number.isFinite(hops) ? hops : 6);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/analyze') {
        const report = analyzeGraph(db);
        sendJson(res, 200, report);
        return;
      }

      if (req.method === 'GET' && pathname === '/metrics') {
        const counts = db.getCounts();
        const telemetry = db.db
          .prepare(
            `SELECT query_type, COUNT(*) AS count, AVG(latency_ms) AS avg_ms, MAX(latency_ms) AS max_ms
             FROM query_telemetry
             GROUP BY query_type
             ORDER BY count DESC`,
          )
          .all();
        const syncRuns = db.db
          .prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 10')
          .all();
        sendJson(res, 200, {
          ok: true,
          counts,
          telemetry,
          recentSyncRuns: syncRuns,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/benchmark') {
        const report = runBenchmark(workspaceRoot, db, indexer);
        sendJson(res, 200, report);
        return;
      }

      sendJson(res, 404, { error: `Unknown endpoint ${req.method} ${pathname}` });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => resolve());
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : requestedPort;

  const close = async (): Promise<void> => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // Ignore close errors
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  };

  return {
    server,
    db,
    indexer,
    port: boundPort,
    close,
  };
}

// CLI entrypoint when invoked directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('/daemon.js') || process.argv[1].endsWith('/daemon.ts'));

if (isMain) {
  const args = process.argv.slice(2);
  let workspaceRoot = process.cwd();
  let port = Number(process.env.AST_GRAPH_PORT ?? 4319);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      workspaceRoot = args[i + 1]!;
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = Number(args[i + 1]!);
      i++;
    }
  }

  startSidecarDaemon({ workspaceRoot, port }).then((instance) => {
    process.stderr.write(
      `[@warehouse/ast-sidecar] Listening on http://127.0.0.1:${instance.port} (workspace: ${workspaceRoot})\n`,
    );
    const shutdown = () => {
      instance.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
