export type ScipSymbolUri = string;

export type NodeKind =
  | 'WorkspacePackage'
  | 'File'
  | 'Class'
  | 'Interface'
  | 'Function'
  | 'Method'
  | 'Property'
  | 'TypeAlias'
  | 'Enum'
  | 'Variable'
  | 'ZodSchema'
  | 'RouteEndpoint'
  | 'TestSuite'
  | 'TestCase'
  | 'TerraformResource'
  | 'TerraformVariable'
  | 'TerraformOutput';

export type EdgeKind =
  | 'CONTAINS'
  | 'IMPORTS'
  | 'EXPORTS'
  | 'CALLS'
  | 'REFERENCES'
  | 'EXTENDS'
  | 'IMPLEMENTS'
  | 'RETURNS_TYPE'
  | 'HAS_PARAMETER_TYPE'
  | 'TESTS_SYMBOL'
  | 'TESTS_FILE'
  | 'VALIDATES_SCHEMA'
  | 'EMITS_SCHEMA'
  | 'HANDLES_ROUTE'
  | 'CONNECTS_ENDPOINT'
  | 'PROVISIONS_SERVICE'
  | 'REFERENCES_TF_RESOURCE'
  | 'CONFIGURES_ENV'
  | 'READS_PROPERTY'
  | 'WRITES_PROPERTY';

export interface GraphFileRecord {
  filePath: string;
  packageName: string;
  language: 'typescript' | 'javascript' | 'terraform' | 'python';
  sha256: string;
  mtimeMs: number;
  sizeBytes: number;
  lineCount: number;
}

export interface GraphNodeRecord {
  id: ScipSymbolUri;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  packageName: string;
  filePath: string;
  language: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  signature: string;
  docstring: string;
  exported: boolean;
  complexity: number;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphEdgeRecord {
  srcId: ScipSymbolUri;
  dstId: ScipSymbolUri;
  kind: EdgeKind;
  filePath: string;
  line: number;
  col: number;
  weight: number;
  properties: Record<string, unknown>;
}

export interface GraphDiagnosticRecord {
  filePath: string;
  enclosingSymbolId: ScipSymbolUri | null;
  compiler: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  line: number;
  col: number;
}

export interface CompilerGraphBatch {
  compiler: string;
  files: GraphFileRecord[];
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
  diagnostics: GraphDiagnosticRecord[];
}

export interface CompilerAdapter {
  readonly name: string;
  readonly languages: readonly string[];
  supportsFile(filePath: string): boolean;
  extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}

export interface SymbolSummary {
  id: ScipSymbolUri;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  packageName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  signature: string;
  docstring: string;
  exported: boolean;
  complexity: number;
  labels: string[];
}

export interface EdgeSummary {
  srcId: ScipSymbolUri;
  srcName: string;
  srcKind: NodeKind;
  srcFilePath: string;
  srcLine: number;
  dstId: ScipSymbolUri;
  dstName: string;
  dstKind: NodeKind;
  dstFilePath: string;
  dstLine: number;
  edgeKind: EdgeKind;
  callSiteFile: string;
  callSiteLine: number;
}

export interface SymbolNeighborhood {
  symbol: SymbolSummary | null;
  matches: SymbolSummary[];
  callers: EdgeSummary[];
  callees: EdgeSummary[];
  typeReferences: EdgeSummary[];
  coveringTests: Array<{
    testId: ScipSymbolUri;
    testName: string;
    testKind: NodeKind;
    filePath: string;
    startLine: number;
    endLine: number;
    edgeKind: EdgeKind;
  }>;
  totalCallersCount: number;
  totalCalleesCount: number;
  totalCoveringTestsCount: number;
  latencyMs: number;
}

export interface PropertyReferenceSite extends EdgeSummary {
  srcStartLine: number;
  srcEndLine: number;
}

export interface SymbolReferencesResult {
  target: string;
  resolvedSymbols: SymbolSummary[];
  writes: PropertyReferenceSite[];
  reads: PropertyReferenceSite[];
  references: PropertyReferenceSite[];
  totalWritesCount: number;
  totalReadsCount: number;
  totalReferencesCount: number;
  latencyMs: number;
}

export interface FileOutlineSymbol {
  id: ScipSymbolUri;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  signature: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  complexity: number;
}

export interface FileOutlineResult {
  query: string;
  filePath: string | null;
  packageName: string | null;
  language: string | null;
  lineCount: number;
  totalSymbolsInFile: number;
  matchedSymbolsCount: number;
  symbols: FileOutlineSymbol[];
  candidateFiles: string[];
  latencyMs: number;
}

export interface BlastRadiusNode {
  id: ScipSymbolUri;
  name: string;
  qualifiedName: string;
  kind: NodeKind;
  packageName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  hopDistance: number;
  viaEdgeKind: EdgeKind;
  fromSymbolId: ScipSymbolUri;
}

export interface BlastRadiusResult {
  target: string;
  resolvedSymbols: SymbolSummary[];
  maxHops: number;
  impactedNodes: BlastRadiusNode[];
  impactedByHop: Record<number, BlastRadiusNode[]>;
  impactedPackages: string[];
  impactedFiles: Array<{
    filePath: string;
    packageName: string;
    symbolCount: number;
    minLine: number;
    maxLine: number;
  }>;
  recommendedTests: Array<{
    testFilePath: string;
    packageName: string;
    testCases: Array<{
      id: ScipSymbolUri;
      name: string;
      kind: NodeKind;
      startLine: number;
      endLine: number;
    }>;
  }>;
  vitestCommand: string;
  latencyMs: number;
}

export interface TestsForChangeResult {
  target: string;
  resolvedSymbols: SymbolSummary[];
  directTests: Array<{
    id: ScipSymbolUri;
    name: string;
    kind: NodeKind;
    filePath: string;
    packageName: string;
    startLine: number;
    endLine: number;
    targetSymbolName: string;
    edgeKind: EdgeKind;
  }>;
  transitiveTests: Array<{
    id: ScipSymbolUri;
    name: string;
    kind: NodeKind;
    filePath: string;
    packageName: string;
    startLine: number;
    endLine: number;
    hopDistance: number;
  }>;
  testFiles: string[];
  vitestCommand: string;
  latencyMs: number;
}

export interface LineageResult {
  target: string;
  focalNodes: SymbolSummary[];
  validators: EdgeSummary[];
  emitters: EdgeSummary[];
  routesHandled: EdgeSummary[];
  endpointClients: EdgeSummary[];
  infraProvisions: EdgeSummary[];
  downstreamConsumers: EdgeSummary[];
  upstreamProviders: EdgeSummary[];
  latencyMs: number;
}

export interface ShortestPathStep {
  fromId: ScipSymbolUri;
  fromName: string;
  fromFile: string;
  edgeKind: EdgeKind;
  toId: ScipSymbolUri;
  toName: string;
  toFile: string;
  line: number;
}

export interface ShortestPathResult {
  fromTarget: string;
  toTarget: string;
  found: boolean;
  hopCount: number;
  path: ShortestPathStep[];
  latencyMs: number;
}

export interface PackageCouplingMetric {
  packageName: string;
  afferentCouplingCa: number;
  efferentCouplingCe: number;
  instability: number;
  incomingPackages: string[];
  outgoingPackages: string[];
}

export interface UntestedHubSymbol {
  id: ScipSymbolUri;
  name: string;
  qualifiedName: string;
  kind: NodeKind;
  packageName: string;
  filePath: string;
  startLine: number;
  fanIn: number;
  complexity: number;
  riskScore: number;
}

export interface StructuralAnalysisReport {
  generatedAt: string;
  totals: {
    files: number;
    nodes: number;
    edges: number;
    diagnostics: number;
    packages: number;
  };
  nodesByKind: Record<string, number>;
  nodesByLanguage: Record<string, number>;
  edgesByKind: Record<string, number>;
  packageCoupling: PackageCouplingMetric[];
  untestedHighFanInHubs: UntestedHubSymbol[];
  deadExports: Array<{
    id: ScipSymbolUri;
    name: string;
    kind: NodeKind;
    packageName: string;
    filePath: string;
    startLine: number;
  }>;
  circularDependencies: Array<{
    scope: 'package' | 'file';
    cycle: string[];
  }>;
  latencyMs: number;
}

export interface TraceabilityScenarioComparison {
  scenarioName: string;
  targetQuery: string;
  resolvedSymbolId: string;
  grepBaseline: {
    matchedFilesCount: number;
    totalLinesAcrossMatchedFiles: number;
    totalCharsAcrossMatchedFiles: number;
    estimatedTokensFullFileRead: number;
    fullWorkspaceTestFilesCount: number;
    grepDurationMs: number;
  };
  astGraphApproach: {
    impactedFilesCount: number;
    impactedSymbolsCount: number;
    distilledSliceLines: number;
    distilledSliceChars: number;
    estimatedTokensDistilledSlice: number;
    targetedTestFilesCount: number;
    targetedTestCasesCount: number;
    queryDurationMs: number;
  };
  improvements: {
    filesReadReductionRatio: number;
    estimatedTokenSavingsPct: number;
    targetedTestSelectionRatio: number;
  };
}

export interface BenchmarkReport {
  generatedAt: string;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    engine: string;
  };
  indexing: {
    coldSyncMs: number;
    totalFilesIndexed: number;
    totalNodes: number;
    totalEdges: number;
    filesPerSec: number;
    nodesPerSec: number;
    incrementalSingleFileSyncMs: number;
    lazyUnchangedCheckMs: number;
  };
  queryLatenciesMs: {
    sampleCount: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    minMs: number;
    maxMs: number;
    byQueryType: Record<string, { count: number; avgMs: number; maxMs: number }>;
  };
  traceabilityComparisons: TraceabilityScenarioComparison[];
  aggregateEfficiency: {
    avgFilesReadReductionRatio: number;
    avgTokenSavingsPct: number;
    avgTargetedTestSelectionRatio: number;
  };
  telemetrySummary: {
    totalRecordedQueries: number;
    avgLatencyMs: number;
    topQueryTypes: Array<{ queryType: string; count: number; avgMs: number }>;
  };
}
