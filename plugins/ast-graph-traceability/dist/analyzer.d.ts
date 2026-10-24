import type { AstGraphDatabase } from './db.js';
import type { AstGraphIndexer } from './indexer.js';
import type { BenchmarkReport, StructuralAnalysisReport } from './types.js';
export declare function analyzeGraph(db: AstGraphDatabase): StructuralAnalysisReport;
export declare function runBenchmark(workspaceRoot: string, db: AstGraphDatabase, indexer: AstGraphIndexer): BenchmarkReport;
//# sourceMappingURL=analyzer.d.ts.map