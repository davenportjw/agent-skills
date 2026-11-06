import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessWorkspace } from '../src/assessor.js';
import { formatCompactCliOutput, SUMMARY_MARKER } from '../src/cli.js';
import { AstGraphDatabase } from '../src/db.js';
import { AstGraphIndexer } from '../src/indexer.js';
import { AstMcpServer, normalizeMcpToolArgs } from '../src/mcp.js';

const tempDirs: string[] = [];

function createTempGitRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('Conversation audit regressions (keynote, generative-learning, smartrouter, agent-skills)', () => {
  it('indexes .tsx/.jsx files, nested React component handlers, TypeAlias properties, and cross-file property mutations/destructuring', () => {
    const repo = createTempGitRepo('ast-audit-tsx-');
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'keynote-studio', version: '1.0.0', type: 'module' }, null, 2),
    );
    fs.writeFileSync(
      path.join(repo, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            jsx: 'preserve',
            strict: true,
          },
          include: ['src'],
        },
        null,
        2,
      ),
    );

    const srcDir = path.join(repo, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'types.ts'),
      `export interface StudioState {
  takes: string[];
  comments: string[];
}

export type TelemetryConfig = {
  flushIntervalMs: number;
  endpointUrl: string;
};

export class InternalController {
  public activeShowId = 'default';
  private secretToken = 'hidden';
  protected internalCounter = 0;

  public resetShow(): void {
    this.activeShowId = 'reset';
  }

  private clearSecret(): void {
    this.secretToken = '';
  }
}
`,
    );

    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      `import type { StudioState, TelemetryConfig } from './types.js';

export function App(initialState: StudioState) {
  const handleCreateNewShow = async (title: string) => {
    initialState.takes.push(title);
    initialState.comments = [];
    return title;
  };

  function computeSlideTiming(config: TelemetryConfig): number {
    const { takes, comments } = initialState;
    return takes.length + comments.length + config.flushIntervalMs;
  }

  const nextState: StudioState = {
    takes: ['intro'],
    comments: ['ready'],
  };

  return { handleCreateNewShow, computeSlideTiming, nextState };
}
`,
    );

    fs.writeFileSync(
      path.join(srcDir, 'main.tsx'),
      `import { App } from './App.js';

export function bootstrapApp() {
  return App({ takes: [], comments: [] });
}
`,
    );

    const assessment = assessWorkspace(repo);
    expect(assessment.fileCounts.typescript).toBe(3);
    expect(assessment.frameworks).toContain('React');

    const dbPath = path.join(repo, '.ast-graph', 'ast.db');
    const db = new AstGraphDatabase(dbPath);
    const indexer = new AstGraphIndexer(repo, db);
    const syncRes = indexer.syncWorkspace({ full: true });
    expect(syncRes.totals.files).toBe(3);

    // 1. Outline of src/App.tsx should include App and nested functions handleCreateNewShow & computeSlideTiming
    const outline = db.getFileOutline('src/App.tsx', { kind: 'Function' });
    expect(outline.filePath).toBe('src/App.tsx');
    const names = outline.symbols.map((s) => s.name);
    expect(names).toContain('App');
    expect(names).toContain('handleCreateNewShow');
    expect(names).toContain('computeSlideTiming');

    // 2. Symbol lookup on nested React handler handleCreateNewShow
    const handlerSym = db.getSymbolNeighborhood('handleCreateNewShow');
    expect(handlerSym.symbol).not.toBeNull();
    expect(handlerSym.symbol?.filePath).toBe('src/App.tsx');
    expect(handlerSym.symbol?.qualifiedName).toContain('App.handleCreateNewShow');

    // 3. Querying src/main.ts auto-resolves to src/main.tsx, and querying a near-miss stem ranks src/App.tsx #1
    const autoMain = db.getFileOutline('src/main.ts');
    expect(autoMain.filePath).toBe('src/main.tsx');
    const nearMissApp = db.getFileOutline('src/App-view.tsx');
    expect(nearMissApp.filePath).toBeNull();
    expect(nearMissApp.candidateFiles[0]).toBe('src/App.tsx');

    // 4. Cross-file property references for StudioState.takes and TelemetryConfig.flushIntervalMs
    const takesRefs = db.getSymbolReferences('takes');
    expect(takesRefs.resolvedSymbols.some((s) => s.kind === 'Property' && s.filePath === 'src/types.ts')).toBe(true);
    // .push(title) and object literal { takes: ['intro'] } are tracked as WRITES_PROPERTY
    expect(takesRefs.totalWritesCount).toBeGreaterThanOrEqual(2);
    // const { takes, comments } = initialState and takes.length are tracked as READS_PROPERTY
    expect(takesRefs.totalReadsCount).toBeGreaterThanOrEqual(1);

    const typeAliasPropRefs = db.getSymbolReferences('flushIntervalMs');
    expect(typeAliasPropRefs.resolvedSymbols.some((s) => s.kind === 'Property' && s.name === 'flushIntervalMs')).toBe(
      true,
    );
    expect(typeAliasPropRefs.totalReadsCount).toBeGreaterThanOrEqual(1);

    // 5. Member visibility parity in both full TS adapter and fast incremental TS indexer
    const classOutline = db.getFileOutline('src/types.ts', { exportedOnly: true });
    const exportedNames = classOutline.symbols.map((s) => s.name);
    expect(exportedNames).toContain('resetShow');
    expect(exportedNames).not.toContain('clearSecret');

    // Trigger incremental sync on src/types.ts and verify private members stay exported=false
    fs.writeFileSync(
      path.join(srcDir, 'types.ts'),
      `${fs.readFileSync(path.join(srcDir, 'types.ts'), 'utf8')}\n// incremental touch\n`,
    );
    indexer.syncWorkspace({ targetFiles: ['src/types.ts'] });
    const classOutlineAfterInc = db.getFileOutline('src/types.ts', { exportedOnly: true });
    const exportedNamesAfterInc = classOutlineAfterInc.symbols.map((s) => s.name);
    expect(exportedNamesAfterInc).toContain('resetShow');
    expect(exportedNamesAfterInc).not.toContain('clearSecret');

    db.close();
  });

  it('indexes nested Python FastAPI routes and inner helper functions inside factory functions like create_app()', () => {
    const repo = createTempGitRepo('ast-audit-py-');
    fs.writeFileSync(
      path.join(repo, 'pyproject.toml'),
      `[project]\nname = "generative-learning"\nversion = "0.1.0"\n`,
    );
    fs.writeFileSync(
      path.join(repo, 'app.py'),
      `from fastapi import FastAPI
from pydantic import BaseModel

class QuizSubmission(BaseModel):
    module_id: str
    answers: list[int]

def create_app() -> FastAPI:
    app = FastAPI()

    def score_answers(answers: list[int]) -> int:
        return sum(answers)

    @app.get("/api/curriculum")
    async def get_curriculum():
        return {"modules": []}

    @app.post("/api/quiz/grade")
    async def grade_quiz(payload: QuizSubmission):
        total = score_answers(payload.answers)
        return {"score": total}

    return app
`,
    );

    const dbPath = path.join(repo, '.ast-graph', 'ast.db');
    const db = new AstGraphDatabase(dbPath);
    const indexer = new AstGraphIndexer(repo, db);
    indexer.syncWorkspace({ full: true });

    const routes = db.searchSymbols('', 'RouteEndpoint', 20);
    const routeNames = routes.map((r) => r.name);
    expect(routeNames).toContain('GET /api/curriculum');
    expect(routeNames).toContain('POST /api/quiz/grade');

    const outline = db.getFileOutline('app.py');
    const fnNames = outline.symbols.map((s) => s.name);
    expect(fnNames).toContain('create_app');
    expect(fnNames).toContain('score_answers');
    expect(fnNames).toContain('get_curriculum');
    expect(fnNames).toContain('grade_quiz');

    const lineage = db.getCrossLayerLineage('/api/quiz/grade');
    expect(lineage.focalNodes[0]?.kind).toBe('RouteEndpoint');
    expect(lineage.routesHandled.length).toBeGreaterThanOrEqual(1);

    db.close();
  });

  it('keeps every batch item summary in place without hoisting the last item to the top of the batch', () => {
    const results = [
      {
        query: 'alphaSymbol',
        symbol: {
          id: 'scip-ts npm pkg 1.0.0 src/a.ts/alphaSymbol().',
          name: 'alphaSymbol',
          qualifiedName: 'pkg/alphaSymbol',
          kind: 'Function',
          filePath: 'src/a.ts',
          startLine: 10,
          endLine: 25,
          signature: 'export function alphaSymbol(): void',
          exported: true,
          complexity: 2,
        },
        callers: [],
        callees: [],
        propertyReads: [],
        propertyWrites: [],
        coveringTests: [],
         VitestCommand: 'npx vitest run',
      },
      {
        query: 'missingBetaSymbol',
        symbol: null,
        callers: [],
        callees: [],
        propertyReads: [],
        propertyWrites: [],
        coveringTests: [],
        didYouMean: [],
      },
    ];

    const out = formatCompactCliOutput('symbol', { results }, '', { tee: false });
    const lines = out.split('\n');
    // Line 0 must be [AST BATCH] 2 targets, and Line 1 must NOT be === TARGET SUMMARY === from item 2!
    expect(lines[0]).toContain('[AST BATCH] 2 targets');
    expect(lines[1]).not.toBe(SUMMARY_MARKER);

    const item1Idx = out.indexOf('### [1/2] alphaSymbol');
    const item2Idx = out.indexOf('### [2/2] missingBetaSymbol');
    expect(item1Idx).toBeGreaterThan(0);
    expect(item2Idx).toBeGreaterThan(item1Idx);

    // Item 2 must preserve its query name instead of falling back to "#2"
    const item2Slice = out.slice(item2Idx);
    expect(item2Slice).toContain('Query: "missingBetaSymbol" (No exact match');
  });

  it('distinguishes indexed files with 0 filter matches from unindexed files, and avoids bogus Top Match on 0-hit searches', () => {
    const indexedZeroMatch = formatCompactCliOutput(
      'outline',
      {
        filePath: 'src/App.tsx',
        query: 'src/App.tsx',
        symbols: [],
        totalSymbolsInFile: 24,
        matchedSymbolsCount: 0,
        lineCount: 400,
        candidateFiles: ['src/App.tsx', 'src/main.tsx'],
      },
      'src/App.tsx',
      { tee: false },
    );
    expect(indexedZeroMatch).toContain('24 symbols exist in src/App.tsx but none matched the filter/kind');
    expect(indexedZeroMatch).not.toContain('No exact file match for "src/App.tsx"');

    const zeroHitSearch = formatCompactCliOutput(
      'search',
      {
        query: 'nonExistentHandler',
        matches: [],
        didYouMean: [
          {
            name: 'existingHandler',
            kind: 'Function',
            filePath: 'src/handlers.ts',
            startLine: 12,
            endLine: 30,
          },
        ],
      },
      'nonExistentHandler',
      { tee: false },
    );
    expect(zeroHitSearch).not.toContain('Top Match:');
    expect(zeroHitSearch).toContain('Closest Suggestion: existingHandler');
  });

  it('normalizes symbolOrFile and single-item array queries in AstMcpServer', async () => {
    const normTests = normalizeMcpToolArgs('ast_tests_for', { symbolOrFile: 'src/App.tsx' });
    expect(normTests.symbolTargets).toContain('src/App.tsx');
    expect(normTests.filePaths).toContain('src/App.tsx');

    const repo = createTempGitRepo('ast-audit-mcp-');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'mcp-test', version: '1.0.0' }));
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'src', 'util.ts'),
      `export function ensureDefaultProject(): string { return 'example-project'; }\n`,
    );

    const server = new AstMcpServer(repo);
    const resp = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ast_symbol',
        arguments: {
          queries: ['ensureDefaultProject'],
          workspace: repo,
        },
      },
    });
    const text = ((resp?.result as { content: Array<{ text: string }> })?.content?.[0]?.text) ?? '';
    expect(text).toContain('ensureDefaultProject');
    expect(text).not.toContain('query=""');
  });
});
