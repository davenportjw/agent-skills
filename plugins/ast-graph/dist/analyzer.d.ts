import type { AstGraphDatabase } from './db.js';
import type { AstGraphIndexer } from './indexer.js';
import type { BenchmarkReport, StructuralAnalysisReport } from './types.js';
export declare function analyzeGraph(db: AstGraphDatabase): StructuralAnalysisReport;
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
export declare function isPolyglotTestFile(relPath: string): boolean;
export declare function synthesizeBenchmarkWorkload(db: AstGraphDatabase): SynthesizedBenchmarkWorkload;
export declare function runBenchmark(workspaceRoot: string, db: AstGraphDatabase, indexer: AstGraphIndexer): BenchmarkReport;
//# sourceMappingURL=analyzer.d.ts.map