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

export interface SynthesizedBenchmarkScenario {
  scenarioName: string;
  targetQuery: string;
  grepTokens: string[];
}

export interface SynthesizedBenchmarkWorkload {
  incrementalTargetPath: string | null;
  symbolTargets: string[];
  lineageTargets: string[];
  shortestPathPair: [string, string];
  scenarios: SynthesizedBenchmarkScenario[];
}

export function isPolyglotTestFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(normalized) ||
    /(^|\/)test_[^/]+\.py$/i.test(normalized) ||
    /_test\.(py|go)$/i.test(normalized) ||
    /(^|\/)tests?\/.*\.(py|ts|tsx|js|go)$/i.test(normalized)
  );
}

export function synthesizeBenchmarkWorkload(db: AstGraphDatabase): SynthesizedBenchmarkWorkload {
  // 1. Select median-sized indexed file for incremental sync benchmark
  const fileRows = db.db
    .prepare('SELECT file_path FROM files ORDER BY line_count ASC, file_path ASC')
    .all() as Array<{ file_path: string }>;
  const incrementalTargetPath =
    fileRows.length > 0 ? fileRows[Math.floor(fileRows.length / 2)]!.file_path : null;

  // 2. Rank non-test symbols by total degree (in_degree + out_degree) and test coverage
  interface RankedSymbolRow {
    id: string;
    name: string;
    qualified_name: string;
    kind: string;
    file_path: string;
    exported: number;
    in_degree: number;
    out_degree: number;
    covers_count: number;
    total_degree: number;
  }

  const rankedRows = db.db
    .prepare(
      `SELECT
         n.id,
         n.name,
         n.qualified_name,
         n.kind,
         n.file_path,
         n.exported,
         COALESCE(inc.c, 0) AS in_degree,
         COALESCE(outc.c, 0) AS out_degree,
         COALESCE(cov.c, 0) AS covers_count,
         (COALESCE(inc.c, 0) * 2 + COALESCE(outc.c, 0) + COALESCE(cov.c, 0) * 2) AS total_degree
       FROM nodes n
       LEFT JOIN (
         SELECT dst_id, COUNT(*) AS c
         FROM edges
         WHERE kind IN ('CALLS', 'REFERENCES', 'IMPORTS', 'VALIDATES_SCHEMA', 'CALLS_ROUTE', 'READS_PROPERTY', 'WRITES_PROPERTY')
         GROUP BY dst_id
       ) inc ON inc.dst_id = n.id
       LEFT JOIN (
         SELECT src_id, COUNT(*) AS c
         FROM edges
         WHERE kind IN ('CALLS', 'REFERENCES', 'VALIDATES_SCHEMA', 'CALLS_ROUTE', 'QUERIES_TABLE', 'MUTATES_TABLE')
         GROUP BY src_id
       ) outc ON outc.src_id = n.id
       LEFT JOIN (
         SELECT dst_id, COUNT(*) AS c
         FROM edges
         WHERE kind = 'COVERS'
         GROUP BY dst_id
       ) cov ON cov.dst_id = n.id
       WHERE n.kind NOT IN ('File', 'WorkspacePackage', 'Module', 'Property', 'TestSuite', 'TestCase', 'DocumentSection', 'StylesheetSection', 'CssAtRule')
         AND LENGTH(n.name) >= 3
       ORDER BY total_degree DESC, in_degree DESC, n.exported DESC, n.name ASC
       LIMIT 120`,
    )
    .all() as unknown as RankedSymbolRow[];

  const nonTestRows = rankedRows.filter((r) => !isPolyglotTestFile(r.file_path));
  const pool = nonTestRows.length >= 4 ? nonTestRows : rankedRows;

  const usedQueries = new Set<string>();
  const pickCandidate = (predicate: (r: RankedSymbolRow) => boolean): RankedSymbolRow | undefined => {
    const found = pool.find((r) => !usedQueries.has(r.name) && predicate(r));
    if (found) {
      usedQueries.add(found.name);
      return found;
    }
    const fallback = pool.find((r) => !usedQueries.has(r.name));
    if (fallback) {
      usedQueries.add(fallback.name);
      return fallback;
    }
    return undefined;
  };

  const buildGrepTokens = (row: RankedSymbolRow): string[] => {
    const tokens = new Set<string>([row.name]);
    const neighbors = db.db
      .prepare(
        `SELECT DISTINCT n.name
         FROM edges e
         JOIN nodes n ON (n.id = e.dst_id OR n.id = e.src_id)
         WHERE (e.src_id = ? OR e.dst_id = ?)
           AND n.id != ?
           AND n.kind NOT IN ('Module', 'TestSuite', 'TestCase')
           AND LENGTH(n.name) >= 4
         LIMIT 4`,
      )
      .all(row.id, row.id, row.id) as Array<{ name: string }>;
    for (const nb of neighbors) {
      const cleanName = nb.name.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, '').trim();
      if (cleanName.length >= 3) tokens.add(cleanName);
      if (tokens.size >= 4) break;
    }
    return [...tokens];
  };

  const scenarios: SynthesizedBenchmarkScenario[] = [];

  // Scenario 1: Core Domain Hub (Function or Method with highest degree)
  const coreHub = pickCandidate(
    (r) => (r.kind === 'Function' || r.kind === 'Method') && r.in_degree >= 1,
  );
  if (coreHub) {
    scenarios.push({
      scenarioName: `Core Domain Hub (${coreHub.name} in ${path.basename(coreHub.file_path)})`,
      targetQuery: coreHub.name,
      grepTokens: buildGrepTokens(coreHub),
    });
  }

  // Scenario 2: Data Contract / Schema / Class
  const schemaOrClass = pickCandidate((r) =>
    ['ZodSchema', 'Class', 'Interface', 'TypeAlias', 'SqlTable', 'Enum'].includes(r.kind),
  );
  if (schemaOrClass) {
    scenarios.push({
      scenarioName: `Data Contract / Model (${schemaOrClass.name} [${schemaOrClass.kind}])`,
      targetQuery: schemaOrClass.name,
      grepTokens: buildGrepTokens(schemaOrClass),
    });
  }

  // Scenario 3: Service / Route / Entrypoint / Web Component
  const routeOrService = pickCandidate(
    (r) =>
      ['RouteHandler', 'FastApiRoute', 'TfResource', 'TemplateLandmark'].includes(r.kind) ||
      Boolean(r.exported && (r.kind === 'Function' || r.kind === 'Variable')),
  );
  if (routeOrService) {
    scenarios.push({
      scenarioName: `Service / Route Entrypoint (${routeOrService.name} [${routeOrService.kind}])`,
      targetQuery: routeOrService.name,
      grepTokens: buildGrepTokens(routeOrService),
    });
  }

  // Scenario 4: Tested Helper / High-Fan-In Utility
  const testedHelper = pickCandidate((r) => r.covers_count > 0 || r.in_degree >= 1);
  if (testedHelper) {
    scenarios.push({
      scenarioName: `High-Fan-In Tested Helper (${testedHelper.name} in ${path.basename(testedHelper.file_path)})`,
      targetQuery: testedHelper.name,
      grepTokens: buildGrepTokens(testedHelper),
    });
  }

  const symbolTargets = pool.slice(0, 5).map((r) => r.name);
  while (symbolTargets.length < 5) {
    symbolTargets.push(symbolTargets[0] ?? 'main');
  }

  const lineageCandidates = pool.filter((r) =>
    ['ZodSchema', 'RouteHandler', 'FastApiRoute', 'TfResource', 'SqlTable', 'Class', 'Interface'].includes(r.kind),
  );
  const lineageTargets = [
    lineageCandidates[0]?.name ?? symbolTargets[0] ?? 'main',
    lineageCandidates[1]?.name ?? symbolTargets[1] ?? symbolTargets[0] ?? 'main',
  ];

  // Find a real connected pair for shortestPath if possible
  const connectedPairRow = db.db
    .prepare(
      `SELECT s.name AS src_name, d.name AS dst_name
       FROM edges e
       JOIN nodes s ON s.id = e.src_id
       JOIN nodes d ON d.id = e.dst_id
       WHERE e.kind = 'CALLS'
         AND s.id != d.id
         AND s.kind IN ('Function', 'Method', 'RouteHandler', 'FastApiRoute')
         AND d.kind IN ('Function', 'Method')
       LIMIT 1`,
    )
    .get() as { src_name: string; dst_name: string } | undefined;

  const shortestPathPair: [string, string] = connectedPairRow
    ? [connectedPairRow.src_name, connectedPairRow.dst_name]
    : [symbolTargets[0] ?? 'main', symbolTargets[1] ?? symbolTargets[0] ?? 'main'];

  return {
    incrementalTargetPath,
    symbolTargets,
    lineageTargets,
    shortestPathPair,
    scenarios,
  };
}

export function runBenchmark(
  workspaceRoot: string,
  db: AstGraphDatabase,
  indexer: AstGraphIndexer,
): BenchmarkReport {
  // 1. Cold full sync measurement
  const coldSync = indexer.syncWorkspace({ full: true, exportSnapshots: true });
  const coldSyncMs = round2(coldSync.durationMs);
  const filesPerSec = coldSyncMs > 0 ? round2((coldSync.filesUpdated / coldSyncMs) * 1000) : 0;
  const nodesPerSec = coldSyncMs > 0 ? round2((coldSync.totals.nodes / coldSyncMs) * 1000) : 0;

  // Synthesize workload dynamically from the active repository's graph topology
  const workload = synthesizeBenchmarkWorkload(db);

  // 2. Warm incremental single-file re-index measurement
  const incResult = indexer.syncWorkspace({
    full: false,
    targetPaths: workload.incrementalTargetPath ? [workload.incrementalTargetPath] : [],
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

  for (const sym of workload.symbolTargets) {
    runTimed('searchSymbols', () => db.searchSymbols(sym));
    runTimed('getSymbolNeighborhood', () => db.getSymbolNeighborhood(sym));
    runTimed('getBlastRadius', () => db.getBlastRadius(sym, 3));
  }
  runTimed('getTestsForChange', () => db.getTestsForChange(workload.symbolTargets[0]!));
  runTimed('getTestsForChange', () => db.getTestsForChange(workload.symbolTargets[1]!));
  runTimed('getCrossLayerLineage', () => db.getCrossLayerLineage(workload.lineageTargets[0]!));
  runTimed('getCrossLayerLineage', () => db.getCrossLayerLineage(workload.lineageTargets[1]!));
  runTimed('findShortestPath', () =>
    db.findShortestPath(workload.shortestPathPair[0], workload.shortestPathPair[1]),
  );

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

  // 5. Empirical Traceability & Fix Efficiency Comparison across synthesized repository scenarios
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

  const dbTestFiles = (
    db.db
      .prepare("SELECT DISTINCT file_path FROM nodes WHERE kind IN ('TestCase', 'TestSuite')")
      .all() as Array<{ file_path: string }>
  ).map((r) => r.file_path);

  const allWorkspaceTestFiles = Array.from(
    new Set([
      ...[...fileContentsCache.keys()].filter((f) => isPolyglotTestFile(f)),
      ...dbTestFiles,
    ]),
  );

  const scenarios = workload.scenarios;

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
