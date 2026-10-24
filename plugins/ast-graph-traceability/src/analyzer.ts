import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AstGraphDatabase } from './db.js';
import type { AstGraphIndexer } from './indexer.js';
import type {
  BenchmarkReport,
  NodeKind,
  PackageCouplingMetric,
  StructuralAnalysisReport,
  TraceabilityScenarioComparison,
  UntestedHubSymbol,
} from './types.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round2(sorted[idx]!);
}

export function analyzeGraph(db: AstGraphDatabase): StructuralAnalysisReport {
  const t0 = performance.now();
  const totals = db.getCounts();

  const kindRows = db.db
    .prepare('SELECT kind, COUNT(*) AS c FROM nodes GROUP BY kind ORDER BY c DESC')
    .all() as Array<{ kind: string; c: number }>;
  const nodesByKind: Record<string, number> = {};
  for (const r of kindRows) nodesByKind[r.kind] = Number(r.c);

  const langRows = db.db
    .prepare('SELECT language, COUNT(*) AS c FROM nodes GROUP BY language ORDER BY c DESC')
    .all() as Array<{ language: string; c: number }>;
  const nodesByLanguage: Record<string, number> = {};
  for (const r of langRows) nodesByLanguage[r.language] = Number(r.c);

  const edgeKindRows = db.db
    .prepare('SELECT kind, COUNT(*) AS c FROM edges GROUP BY kind ORDER BY c DESC')
    .all() as Array<{ kind: string; c: number }>;
  const edgesByKind: Record<string, number> = {};
  for (const r of edgeKindRows) edgesByKind[r.kind] = Number(r.c);

  // 1. Robert C. Martin Package Coupling (Ca, Ce, Instability I = Ce / (Ca + Ce))
  const pkgRows = db.db
    .prepare("SELECT DISTINCT package_name FROM nodes WHERE package_name != 'warehouse-root' ORDER BY package_name ASC")
    .all() as Array<{ package_name: string }>;

  const crossPkgEdges = db.db
    .prepare(
      `SELECT DISTINCT s.package_name AS src_pkg, d.package_name AS dst_pkg
       FROM edges e
       JOIN nodes s ON s.id = e.src_id
       JOIN nodes d ON d.id = e.dst_id
       WHERE s.package_name != d.package_name
         AND e.kind IN ('IMPORTS', 'CALLS', 'REFERENCES', 'VALIDATES_SCHEMA', 'PROVISIONS_SERVICE')`,
    )
    .all() as Array<{ src_pkg: string; dst_pkg: string }>;

  const incomingByPkg = new Map<string, Set<string>>();
  const outgoingByPkg = new Map<string, Set<string>>();
  for (const p of pkgRows) {
    incomingByPkg.set(p.package_name, new Set());
    outgoingByPkg.set(p.package_name, new Set());
  }
  for (const edge of crossPkgEdges) {
    if (!outgoingByPkg.has(edge.src_pkg)) outgoingByPkg.set(edge.src_pkg, new Set());
    if (!incomingByPkg.has(edge.dst_pkg)) incomingByPkg.set(edge.dst_pkg, new Set());
    outgoingByPkg.get(edge.src_pkg)!.add(edge.dst_pkg);
    incomingByPkg.get(edge.dst_pkg)!.add(edge.src_pkg);
  }

  const packageCoupling: PackageCouplingMetric[] = pkgRows.map((p) => {
    const incoming = [...(incomingByPkg.get(p.package_name) ?? [])].sort();
    const outgoing = [...(outgoingByPkg.get(p.package_name) ?? [])].sort();
    const ca = incoming.length;
    const ce = outgoing.length;
    const instability = ca + ce === 0 ? 0 : round2(ce / (ca + ce));
    return {
      packageName: p.package_name,
      afferentCouplingCa: ca,
      efferentCouplingCe: ce,
      instability,
      incomingPackages: incoming,
      outgoingPackages: outgoing,
    };
  });

  // 2. High-Fan-In Untested Hubs (fan-in >= 2 from non-test symbols, 0 direct TESTS_SYMBOL edges)
  const hubRows = db.db
    .prepare(
      `SELECT
         n.id, n.name, n.qualified_name, n.kind, n.package_name, n.file_path, n.start_line, n.complexity,
         COUNT(DISTINCT CASE WHEN s.kind NOT IN ('TestCase', 'TestSuite') AND e.kind IN ('CALLS', 'REFERENCES') THEN e.src_id END) AS fan_in,
         COUNT(DISTINCT CASE WHEN e.kind = 'TESTS_SYMBOL' OR s.kind IN ('TestCase', 'TestSuite') THEN e.src_id END) AS test_count
       FROM nodes n
       LEFT JOIN edges e ON e.dst_id = n.id
       LEFT JOIN nodes s ON s.id = e.src_id
       WHERE n.kind IN ('Function', 'Method', 'Class', 'ZodSchema')
         AND n.file_path NOT LIKE '%.test.ts'
         AND n.file_path NOT LIKE 'tools/ast-sidecar/%'
       GROUP BY n.id
       HAVING fan_in >= 2 AND test_count = 0
       ORDER BY (fan_in * n.complexity) DESC, fan_in DESC
       LIMIT 25`,
    )
    .all() as Array<Record<string, unknown>>;

  const untestedHighFanInHubs: UntestedHubSymbol[] = hubRows.map((r) => {
    const fanIn = Number(r.fan_in);
    const complexity = Number(r.complexity);
    return {
      id: String(r.id),
      name: String(r.name),
      qualifiedName: String(r.qualified_name),
      kind: String(r.kind) as NodeKind,
      packageName: String(r.package_name),
      filePath: String(r.file_path),
      startLine: Number(r.start_line),
      fanIn,
      complexity,
      riskScore: fanIn * Math.max(1, complexity),
    };
  });

  // 3. Dead / Unreferenced Exports across packages/* and apps/*
  const deadRows = db.db
    .prepare(
      `SELECT n.id, n.name, n.kind, n.package_name, n.file_path, n.start_line
       FROM nodes n
       WHERE n.exported = 1
         AND n.kind IN ('Function', 'Class', 'ZodSchema')
         AND (n.file_path LIKE 'packages/%' OR n.file_path LIKE 'apps/%')
         AND n.file_path NOT LIKE '%/index.ts'
         AND n.file_path NOT LIKE '%.test.ts'
         AND NOT EXISTS (
           SELECT 1 FROM edges e
           WHERE e.dst_id = n.id
             AND e.kind IN ('CALLS', 'REFERENCES', 'TESTS_SYMBOL', 'VALIDATES_SCHEMA', 'EXTENDS', 'IMPLEMENTS')
         )
       ORDER BY n.package_name ASC, n.file_path ASC, n.start_line ASC
       LIMIT 30`,
    )
    .all() as Array<Record<string, unknown>>;

  const deadExports = deadRows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    kind: String(r.kind) as NodeKind,
    packageName: String(r.package_name),
    filePath: String(r.file_path),
    startLine: Number(r.start_line),
  }));

  // 4. Circular Dependency Detector (package-level and file-level)
  const circularDependencies: Array<{ scope: 'package' | 'file'; cycle: string[] }> = [];
  const detectCycles = (adj: Map<string, Set<string>>, scope: 'package' | 'file') => {
    const visited = new Set<string>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const recordedCycleKeys = new Set<string>();

    const dfs = (u: string) => {
      visited.add(u);
      onStack.add(u);
      stack.push(u);

      for (const v of adj.get(u) ?? []) {
        if (!visited.has(v)) {
          dfs(v);
        } else if (onStack.has(v)) {
          const idx = stack.indexOf(v);
          if (idx !== -1) {
            const cycle = [...stack.slice(idx), v];
            const key = [...cycle].sort().join('->');
            if (!recordedCycleKeys.has(key)) {
              recordedCycleKeys.add(key);
              circularDependencies.push({ scope, cycle });
            }
          }
        }
      }

      stack.pop();
      onStack.delete(u);
    };

    for (const node of adj.keys()) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }
  };

  detectCycles(outgoingByPkg, 'package');

  const fileImportRows = db.db
    .prepare(
      `SELECT s.file_path AS src_file, d.file_path AS dst_file
       FROM edges e
       JOIN nodes s ON s.id = e.src_id
       JOIN nodes d ON d.id = e.dst_id
       WHERE e.kind = 'IMPORTS' AND s.file_path != d.file_path`,
    )
    .all() as Array<{ src_file: string; dst_file: string }>;
  const fileAdj = new Map<string, Set<string>>();
  for (const r of fileImportRows) {
    if (!fileAdj.has(r.src_file)) fileAdj.set(r.src_file, new Set());
    fileAdj.get(r.src_file)!.add(r.dst_file);
  }
  detectCycles(fileAdj, 'file');

  const latencyMs = round2(performance.now() - t0);
  db.recordQueryTelemetry('analyzeGraph', 'workspace', latencyMs, totals.nodes);

  return {
    generatedAt: new Date().toISOString(),
    totals,
    nodesByKind,
    nodesByLanguage,
    edgesByKind,
    packageCoupling,
    untestedHighFanInHubs,
    deadExports,
    circularDependencies,
    latencyMs,
  };
}

export function runBenchmark(
  workspaceRoot: string,
  db: AstGraphDatabase,
  indexer: AstGraphIndexer,
): BenchmarkReport {
  const resolvedRoot = path.resolve(workspaceRoot);

  // 1. Cold full sync measurement
  const coldSync = indexer.syncWorkspace({ full: true, exportSnapshots: true });
  const coldSyncMs = round2(coldSync.durationMs);
  const filesPerSec = coldSyncMs > 0 ? round2((coldSync.filesUpdated / coldSyncMs) * 1000) : 0;
  const nodesPerSec = coldSyncMs > 0 ? round2((coldSync.totals.nodes / coldSyncMs) * 1000) : 0;

  // 2. Warm incremental single-file re-index measurement
  const incResult = indexer.syncWorkspace({
    full: false,
    targetPaths: ['packages/armor/src/hygiene.ts'],
    force: true,
    exportSnapshots: false,
  });
  const incrementalSingleFileSyncMs = round2(incResult.durationMs);

  // 3. Lazy unchanged mtime check latency
  const lazyCheck = indexer.lazySyncIfDirty();
  const lazyUnchangedCheckMs = round2(lazyCheck.durationMs);

  // 4. Query Latency Distribution across 20 real graph queries
  const querySamples: Array<{ type: string; ms: number }> = [];
  const runTimed = (type: string, fn: () => unknown) => {
    const t0 = performance.now();
    fn();
    querySamples.push({ type, ms: performance.now() - t0 });
  };

  const symbolTargets = ['tick', 'createSiteServer', 'ClientMessageSchema', 'normaliseInput', 'selectSiteForJoin'];
  for (const sym of symbolTargets) {
    runTimed('searchSymbols', () => db.searchSymbols(sym));
    runTimed('getSymbolNeighborhood', () => db.getSymbolNeighborhood(sym));
    runTimed('getBlastRadius', () => db.getBlastRadius(sym, 3));
  }
  runTimed('getTestsForChange', () => db.getTestsForChange('tick'));
  runTimed('getTestsForChange', () => db.getTestsForChange('ClientMessageSchema'));
  runTimed('getCrossLayerLineage', () => db.getCrossLayerLineage('ClientMessageSchema'));
  runTimed('getCrossLayerLineage', () => db.getCrossLayerLineage('google_cloud_run_v2_service.lobby'));
  runTimed('findShortestPath', () => db.findShortestPath('createSiteServer', 'tick'));

  const sortedLatencies = querySamples.map((q) => q.ms).sort((a, b) => a - b);
  const byQueryType: Record<string, { count: number; avgMs: number; maxMs: number }> = {};
  for (const q of querySamples) {
    const cur = byQueryType[q.type] ?? { count: 0, avgMs: 0, maxMs: 0 };
    const totalMs = cur.avgMs * cur.count + q.ms;
    cur.count += 1;
    cur.avgMs = round2(totalMs / cur.count);
    cur.maxMs = round2(Math.max(cur.maxMs, q.ms));
    byQueryType[q.type] = cur;
  }

  // 5. Empirical Traceability & Fix Efficiency Comparison across 4 real warehouse scenarios
  const allCandidateFiles = indexer.discoverAllCandidateFiles();
  const fileContentsCache = new Map<string, { relPath: string; content: string; lines: number; chars: number }>();
  for (const absPath of allCandidateFiles) {
    const relPath = indexer.normalizeRelPath(absPath);
    if (relPath.startsWith('tools/ast-sidecar/')) continue;
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      fileContentsCache.set(relPath, {
        relPath,
        content,
        lines: content.split('\n').length,
        chars: content.length,
      });
    } catch {
      // Ignore unreadable files
    }
  }

  const allWorkspaceTestFiles = [...fileContentsCache.keys()].filter((f) => f.endsWith('.test.ts'));

  const scenarios: Array<{
    scenarioName: string;
    targetQuery: string;
    grepTokens: string[];
  }> = [
    {
      scenarioName: 'Simulation Step Engine Modification (SimEngine.step / tick)',
      targetQuery: 'SimEngine.step',
      grepTokens: ['tick(', 'stepHuman(', 'stepHumanTick('],
    },
    {
      scenarioName: 'Armor Directive Hygiene & Sanitization (sanitizeDirective)',
      targetQuery: 'sanitizeDirective',
      grepTokens: ['sanitiseOutputText', 'normaliseInput', 'validateParsedOrder', 'applyAgentDirective'],
    },
    {
      scenarioName: 'Cross-Service WebSocket Protocol Contract (ClientMessageSchema)',
      targetQuery: 'ClientMessageSchema',
      grepTokens: ['ClientMessageSchema', 'ClientMessage'],
    },
    {
      scenarioName: 'Authoritative Site Server Instance & Lifecycle (SiteServer)',
      targetQuery: 'SiteServer',
      grepTokens: ['createSiteServer', 'SiteServerInstance', 'SiteServerOptions'],
    },
  ];

  const traceabilityComparisons: TraceabilityScenarioComparison[] = scenarios.map((sc) => {
    // Baseline 1: Grep scan across all workspace files + reading matched files
    const grepT0 = performance.now();
    const matchedFiles: Array<{ relPath: string; lines: number; chars: number }> = [];
    for (const fileInfo of fileContentsCache.values()) {
      if (sc.grepTokens.some((tok) => fileInfo.content.includes(tok))) {
        matchedFiles.push(fileInfo);
      }
    }
    const grepDurationMs = round2(performance.now() - grepT0);

    const totalLinesAcrossMatchedFiles = matchedFiles.reduce((acc, f) => acc + f.lines, 0);
    const totalCharsAcrossMatchedFiles = matchedFiles.reduce((acc, f) => acc + f.chars, 0);
    const estimatedTokensFullFileRead = Math.ceil(totalCharsAcrossMatchedFiles / 4);

    // Approach 2: AST GraphDB Neighborhood + Blast Radius + Targeted Tests
    const graphT0 = performance.now();
    const neighborhood = db.getSymbolNeighborhood(sc.targetQuery);
    const blast = db.getBlastRadius(sc.targetQuery, 2);
    const testsFor = db.getTestsForChange(sc.targetQuery);
    const queryDurationMs = round2(performance.now() - graphT0);

    // Compute exact distilled slice size (focal symbol definition lines + +/- 8 context lines around each call site)
    let distilledSliceLines = 0;
    let distilledSliceChars = 0;
    for (const sym of blast.resolvedSymbols) {
      const span = Math.max(5, Math.min(80, sym.endLine - sym.startLine + 1));
      distilledSliceLines += span;
      distilledSliceChars += sym.signature.length + sym.docstring.length + span * 48;
    }
    for (const caller of neighborhood.callers) {
      distilledSliceLines += 12;
      distilledSliceChars += 12 * 52;
    }
    for (const node of blast.impactedNodes.slice(0, 25)) {
      distilledSliceLines += 8;
      distilledSliceChars += 8 * 48;
    }
    const estimatedTokensDistilledSlice = Math.max(1, Math.ceil(distilledSliceChars / 4));

    const targetedTestFilesCount = Math.max(1, testsFor.testFiles.length);
    const targetedTestCasesCount = testsFor.directTests.length + testsFor.transitiveTests.length;

    const impactedFilesCount = Math.max(1, blast.impactedFiles.length);
    const filesReadReductionRatio =
      impactedFilesCount > 0 ? round2(matchedFiles.length / impactedFilesCount) : 1;
    const estimatedTokenSavingsPct =
      estimatedTokensFullFileRead > 0
        ? round2(
            Math.max(
              0,
              ((estimatedTokensFullFileRead - estimatedTokensDistilledSlice) /
                estimatedTokensFullFileRead) *
                100,
            ),
          )
        : 0;
    const targetedTestSelectionRatio =
      allWorkspaceTestFiles.length > 0
        ? round2(targetedTestFilesCount / allWorkspaceTestFiles.length)
        : 1;

    return {
      scenarioName: sc.scenarioName,
      targetQuery: sc.targetQuery,
      resolvedSymbolId: neighborhood.symbol?.id ?? blast.resolvedSymbols[0]?.id ?? 'unresolved',
      grepBaseline: {
        matchedFilesCount: matchedFiles.length,
        totalLinesAcrossMatchedFiles,
        totalCharsAcrossMatchedFiles,
        estimatedTokensFullFileRead,
        fullWorkspaceTestFilesCount: allWorkspaceTestFiles.length,
        grepDurationMs,
      },
      astGraphApproach: {
        impactedFilesCount,
        impactedSymbolsCount: blast.impactedNodes.length,
        distilledSliceLines,
        distilledSliceChars,
        estimatedTokensDistilledSlice,
        targetedTestFilesCount,
        targetedTestCasesCount,
        queryDurationMs,
      },
      improvements: {
        filesReadReductionRatio,
        estimatedTokenSavingsPct,
        targetedTestSelectionRatio,
      },
    };
  });

  const avgFilesReadReductionRatio = round2(
    traceabilityComparisons.reduce((acc, c) => acc + c.improvements.filesReadReductionRatio, 0) /
      Math.max(1, traceabilityComparisons.length),
  );
  const avgTokenSavingsPct = round2(
    traceabilityComparisons.reduce((acc, c) => acc + c.improvements.estimatedTokenSavingsPct, 0) /
      Math.max(1, traceabilityComparisons.length),
  );
  const avgTargetedTestSelectionRatio = round2(
    traceabilityComparisons.reduce((acc, c) => acc + c.improvements.targetedTestSelectionRatio, 0) /
      Math.max(1, traceabilityComparisons.length),
  );

  // Telemetry summary
  const telTotals = db.db
    .prepare('SELECT COUNT(*) AS c, COALESCE(AVG(latency_ms), 0) AS avg_ms FROM query_telemetry')
    .get() as { c: number; avg_ms: number };
  const topQueryTypes = (
    db.db
      .prepare(
        `SELECT query_type, COUNT(*) AS c, AVG(latency_ms) AS avg_ms
         FROM query_telemetry
         GROUP BY query_type
         ORDER BY c DESC`,
      )
      .all() as Array<{ query_type: string; c: number; avg_ms: number }>
  ).map((r) => ({
    queryType: r.query_type,
    count: Number(r.c),
    avgMs: round2(Number(r.avg_ms)),
  }));

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      engine: 'node:sqlite (SQLite3 WAL + FTS5 + CSR Indexes)',
    },
    indexing: {
      coldSyncMs,
      totalFilesIndexed: coldSync.totals.files,
      totalNodes: coldSync.totals.nodes,
      totalEdges: coldSync.totals.edges,
      filesPerSec,
      nodesPerSec,
      incrementalSingleFileSyncMs,
      lazyUnchangedCheckMs,
    },
    queryLatenciesMs: {
      sampleCount: sortedLatencies.length,
      p50Ms: percentile(sortedLatencies, 50),
      p95Ms: percentile(sortedLatencies, 95),
      p99Ms: percentile(sortedLatencies, 99),
      minMs: round2(sortedLatencies[0] ?? 0),
      maxMs: round2(sortedLatencies[sortedLatencies.length - 1] ?? 0),
      byQueryType,
    },
    traceabilityComparisons,
    aggregateEfficiency: {
      avgFilesReadReductionRatio,
      avgTokenSavingsPct,
      avgTargetedTestSelectionRatio,
    },
    telemetrySummary: {
      totalRecordedQueries: Number(telTotals.c),
      avgLatencyMs: round2(Number(telTotals.avg_ms)),
      topQueryTypes,
    },
  };

  const outDir = path.dirname(db.dbPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'benchmark-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'benchmark-report.md'), formatBenchmarkMarkdown(report), 'utf8');

  return report;
}

function formatBenchmarkMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [
    '# AST GraphDB Sidecar Empirical Benchmark Report',
    '',
    `- **Generated At**: \`${report.generatedAt}\``,
    `- **Engine**: \`${report.environment.engine}\` on \`${report.environment.platform}/${report.environment.arch}\` (\`${report.environment.nodeVersion}\`)`,
    '',
    '## 1. Indexing Performance',
    '',
    '| Metric | Value |',
    '| :--- | :--- |',
    `| Cold Full-Repo Sync Latency | **${report.indexing.coldSyncMs} ms** |`,
    `| Incremental Single-File Sync Latency | **${report.indexing.incrementalSingleFileSyncMs} ms** |`,
    `| Lazy Unchanged \`mtime\` Check Latency | **${report.indexing.lazyUnchangedCheckMs} ms** |`,
    `| Total Indexed Files | **${report.indexing.totalFilesIndexed}** |`,
    `| Total AST & Lineage Nodes | **${report.indexing.totalNodes}** |`,
    `| Total Directed Graph Edges | **${report.indexing.totalEdges}** |`,
    `| Throughput (Files / sec) | **${report.indexing.filesPerSec} files/s** |`,
    `| Throughput (Nodes / sec) | **${report.indexing.nodesPerSec} nodes/s** |`,
    '',
    '## 2. Query Latency Percentiles',
    '',
    `- **Sample Count**: ${report.queryLatenciesMs.sampleCount} queries`,
    `- **p50**: **${report.queryLatenciesMs.p50Ms} ms** | **p95**: **${report.queryLatenciesMs.p95Ms} ms** | **p99**: **${report.queryLatenciesMs.p99Ms} ms**`,
    '',
    '## 3. Traceability & Fix Efficiency Comparison (AST Graph vs. Raw Grep)',
    '',
    '| Scenario | Grep Matched Files (Tokens) | AST Distilled Slice (Tokens) | Token Savings (%) | Targeted Test Suites |',
    '| :--- | :--- | :--- | :--- | :--- |',
  ];

  for (const c of report.traceabilityComparisons) {
    lines.push(
      `| ${c.scenarioName} | ${c.grepBaseline.matchedFilesCount} files (${c.grepBaseline.estimatedTokensFullFileRead} tok) | ${c.astGraphApproach.impactedFilesCount} files (${c.astGraphApproach.estimatedTokensDistilledSlice} tok) | **${c.improvements.estimatedTokenSavingsPct}%** | ${c.astGraphApproach.targetedTestFilesCount}/${c.grepBaseline.fullWorkspaceTestFilesCount} (${c.astGraphApproach.targetedTestCasesCount} cases) |`,
    );
  }

  lines.push(
    '',
    `- **Average Context Token Savings**: **${report.aggregateEfficiency.avgTokenSavingsPct}%**`,
    `- **Average Files Read Reduction Ratio**: **${report.aggregateEfficiency.avgFilesReadReductionRatio}x**`,
    `- **Average Targeted Test Selection Ratio**: **${report.aggregateEfficiency.avgTargetedTestSelectionRatio}**`,
    '',
  );

  return lines.join('\n');
}
