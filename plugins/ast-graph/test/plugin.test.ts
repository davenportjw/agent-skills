import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AstGraphDatabase,
  AstGraphIndexer,
  AstMcpServer,
  assessWorkspace,
  handleHookInvocation,
  runBenchmark,
} from '../src/index.js';

const tempDirs: string[] = [];

function makeTempRepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ast-graph-${name}-`));
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('@agent-skills/ast-graph multi-repo plugin', () => {
  it('assesses a workspace, writes .ast-graph/manifest.json, and updates .git/info/exclude idempotently', () => {
    const repo = makeTempRepo('assessor');
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'demo-app', version: '1.0.0', devDependencies: { vitest: '^3.0.0' } }),
    );
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const hello = () => "world";\n');

    const manifest = assessWorkspace(repo);
    expect(manifest.repoName).toContain('ast-graph-assessor-');
    expect(manifest.languages).toContain('typescript');
    expect(manifest.testRunner).toBe('npx vitest run');
    expect(fs.existsSync(path.join(repo, '.ast-graph', 'manifest.json'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, '.ast-graph', '.gitignore'), 'utf8')).toBe('*\n');

    const excludeText = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(excludeText).toContain('.ast-graph/');

    // Also verify non-git directory still receives .ast-graph/.gitignore with *\n
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-graph-nongit-'));
    tempDirs.push(nonGitDir);
    fs.writeFileSync(path.join(nonGitDir, 'pyproject.toml'), '[project]\nname = "nongit"\n');
    assessWorkspace(nonGitDir);
    expect(fs.readFileSync(path.join(nonGitDir, '.ast-graph', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('enforces tamper protection when a database is opened against a mismatched repository root', () => {
    const repoA = makeTempRepo('repo-a');
    const repoB = makeTempRepo('repo-b');
    fs.writeFileSync(path.join(repoA, 'package.json'), JSON.stringify({ name: 'repo-a' }));
    fs.writeFileSync(path.join(repoB, 'package.json'), JSON.stringify({ name: 'repo-b' }));

    const dbPathA = path.join(repoA, '.ast-graph', 'ast.db');
    const dbA = new AstGraphDatabase(dbPathA);
    try {
      const indexerA = new AstGraphIndexer(repoA, dbA);
      indexerA.syncWorkspace({ full: true });
      expect(() => dbA.verifyRepoBinding(repoB)).toThrow(/TAMPER_GUARD/);
    } finally {
      dbA.close();
    }
  });

  it('indexes Python (Pydantic, FastAPI, self.<attr>, pytest) and SQL DDL cross-layer lineage', () => {
    const repo = makeTempRepo('python-sql');
    fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\nname = "sheep"\nversion = "0.1.0"\n');
    fs.mkdirSync(path.join(repo, 'sql'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'sql', 'schema.sql'),
      `CREATE TABLE AgentMemories (
  memory_id STRING(64) NOT NULL,
  belief_text STRING(MAX)
) PRIMARY KEY (memory_id);
`,
    );

    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'src', 'app.py'),
      `from pydantic import BaseModel
from fastapi import FastAPI

app = FastAPI()

class MemoryPayload(BaseModel):
    memory_id: str
    belief_text: str

class MemoryStore:
    def __init__(self):
        self.active_count = 0

    def save(self, payload: MemoryPayload) -> int:
        self.active_count = self.active_count + 1
        query = "SELECT memory_id FROM AgentMemories WHERE memory_id = @id"
        return self.active_count

@app.post("/api/memories")
async def create_memory(body: MemoryPayload):
    store = MemoryStore()
    return store.save(body)
`,
    );

    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'tests', 'test_app.py'),
      `from src.app import MemoryStore, MemoryPayload

def test_memory_store_save():
    store = MemoryStore()
    res = store.save(MemoryPayload(memory_id="1", belief_text="uv"))
    assert res == 1
`,
    );

    const db = new AstGraphDatabase(path.join(repo, '.ast-graph', 'ast.db'));
    try {
      const indexer = new AstGraphIndexer(repo, db);
      const sync = indexer.syncWorkspace({ full: true });
      expect(sync.totals.files).toBe(3);

      // Check property reads/writes on self.active_count
      const refs = db.getSymbolReferences('active_count');
      expect(refs.totalWritesCount).toBeGreaterThanOrEqual(2);
      expect(refs.totalReadsCount).toBeGreaterThanOrEqual(1);

      // Check FastAPI route + Pydantic schema lineage
      const routeLineage = db.getCrossLayerLineage('/api/memories');
      expect(routeLineage.focalNodes[0]?.kind).toBe('RouteEndpoint');
      expect(routeLineage.routesHandled.length).toBeGreaterThanOrEqual(1);

      // Check SQL table lineage from embedded SQL in Python
      const sqlLineage = db.getCrossLayerLineage('AgentMemories');
      expect(sqlLineage.focalNodes[0]?.name).toBe('AgentMemories');
      expect(sqlLineage.downstreamConsumers.some((c) => c.srcName === 'save')).toBe(true);

      // Check pytest command generation (both symbol-level and file-path-level)
      const tests = db.getTestsForChange('save');
      expect(tests.vitestCommand).toContain('uv run pytest');
      expect(tests.vitestCommand).toContain('tests/test_app.py');

      const fileTests = db.getTestsForChange('src/app.py');
      expect(fileTests.resolvedSymbols.some((s) => s.name === 'save')).toBe(true);
      expect(fileTests.vitestCommand).toContain('uv run pytest');
      expect(fileTests.vitestCommand).toContain('tests/test_app.py');

      const fileNeighborhood = db.getSymbolNeighborhood('src/app.py');
      expect(fileNeighborhood.callees.some((c) => c.dstName === 'save' || c.dstName === 'MemoryStore')).toBe(true);
      expect(fileNeighborhood.coveringTests.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('indexes Go structs, methods, routes, .templ HTMX CALLS_ROUTE edges, and go test suites', () => {
    const repo = makeTempRepo('go-templ');
    fs.writeFileSync(path.join(repo, 'go.mod'), 'module example.com/smartrouter\n\ngo 1.23\n');
    fs.mkdirSync(path.join(repo, 'backend'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'backend', 'server.go'),
      `package backend

import "net/http"

type RouterState struct {
	ActiveModel string \`json:"active_model"\`
}

func (s *RouterState) UpdateModel(next string) string {
	s.ActiveModel = next
	return s.ActiveModel
}

func RegisterRoutes(mux *http.ServeMux, s *RouterState) {
	mux.HandleFunc("POST /api/model", func(w http.ResponseWriter, r *http.Request) {
		s.UpdateModel("gemini-3.8-flash")
	})
}
`,
    );
    fs.writeFileSync(
      path.join(repo, 'backend', 'view.templ'),
      `package backend

templ ModelCard(modelName string) {
	<button hx-post="/api/model" class="btn">{ modelName }</button>
}
`,
    );
    fs.writeFileSync(
      path.join(repo, 'backend', 'server_test.go'),
      `package backend

import "testing"

func TestUpdateModel(t *testing.T) {
	s := &RouterState{}
	got := s.UpdateModel("gemini-3.8-flash")
	if got != "gemini-3.8-flash" {
		t.Fatal(got)
	}
}
`,
    );

    const db = new AstGraphDatabase(path.join(repo, '.ast-graph', 'ast.db'));
    try {
      const indexer = new AstGraphIndexer(repo, db);
      const sync = indexer.syncWorkspace({ full: true });
      expect(sync.totals.files).toBe(3);

      // Check Go struct field writes/reads
      const refs = db.getSymbolReferences('ActiveModel');
      expect(refs.totalWritesCount).toBeGreaterThanOrEqual(1);
      expect(refs.totalReadsCount).toBeGreaterThanOrEqual(1);

      // Check HTMX -> Go route lineage
      const lineage = db.getCrossLayerLineage('/api/model');
      expect(lineage.focalNodes[0]?.kind).toBe('RouteEndpoint');
      expect(lineage.routesHandled.some((e) => e.srcName === 'RegisterRoutes')).toBe(true);
      expect(lineage.endpointClients.some((e) => e.srcName === 'ModelCard')).toBe(true);

      // Check go test command generation
      const tests = db.getTestsForChange('UpdateModel');
      expect(tests.vitestCommand).toContain('go test');
    } finally {
      db.close();
    }
  });

  it('isolates multiple repositories in AstMcpServer and HookHandler without cross-contamination', async () => {
    const repoTs = makeTempRepo('multi-ts');
    const repoPy = makeTempRepo('multi-py');

    fs.writeFileSync(path.join(repoTs, 'package.json'), JSON.stringify({ name: 'multi-ts' }));
    fs.writeFileSync(path.join(repoTs, 'index.ts'), 'export function onlyInTsRepo() { return 42; }\n');

    fs.writeFileSync(path.join(repoPy, 'pyproject.toml'), '[project]\nname = "multi-py"\n');
    fs.writeFileSync(path.join(repoPy, 'main.py'), 'def only_in_py_repo():\n    return "py"\n');

    // Trigger post-tool-use hook on both repos
    await handleHookInvocation(
      'post-tool-use',
      JSON.stringify({
        toolCall: { name: 'write_file', args: { Path: path.join(repoTs, 'index.ts') } },
      }),
    );
    await handleHookInvocation(
      'post-tool-use',
      JSON.stringify({
        toolCall: { name: 'write_file', args: { Path: path.join(repoPy, 'main.py') } },
      }),
    );

    const mcp = new AstMcpServer(repoTs);
    try {
      const tsRes = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ast_symbol', arguments: { query: 'onlyInTsRepo', workspace: repoTs } },
      });
      const tsResultObj = tsRes?.result as {
        content: Array<{ text: string }>;
        structuredContent: { symbol?: { name?: string } | null };
      };
      const tsText = tsResultObj.content[0]?.text ?? '';
      expect(tsText).toContain('[AST SYMBOL] onlyInTsRepo');
      expect(tsText).toContain('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
      expect(tsText.length).toBeLessThan(5500);
      expect(tsResultObj.structuredContent.symbol?.name).toBe('onlyInTsRepo');

      const pyRes = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'ast_symbol', arguments: { query: 'only_in_py_repo', workspace: repoPy } },
      });
      const pyResultObj = pyRes?.result as {
        content: Array<{ text: string }>;
        structuredContent: { symbol?: { name?: string } | null };
      };
      expect(pyResultObj.content[0]?.text).toContain('[AST SYMBOL] only_in_py_repo');
      expect(pyResultObj.structuredContent.symbol?.name).toBe('only_in_py_repo');

      // Ensure py symbol does NOT exist in ts repo DB when workspace is explicitly repoTs
      const crossCheck = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'ast_symbol', arguments: { query: 'only_in_py_repo', workspace: repoTs } },
      });
      const crossResultObj = crossCheck?.result as {
        content: Array<{ text: string }>;
        structuredContent: { symbol?: { name?: string } | null };
      };
      expect(crossResultObj.structuredContent.symbol).toBeNull();

      // Verify auto-resolution when workspace is OMITTED for both symbol query and relative filePath
      const autoPySym = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'ast_symbol', arguments: { query: 'only_in_py_repo' } },
      });
      const autoPySymObj = autoPySym?.result as {
        content: Array<{ text: string }>;
        structuredContent: { symbol?: { name?: string } | null };
      };
      expect(autoPySymObj.structuredContent.symbol?.name).toBe('only_in_py_repo');

      const autoPyOutline = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'ast_outline', arguments: { filePath: 'main.py' } },
      });
      const autoPyOutlineText =
        (autoPyOutline?.result as { content: Array<{ text: string }> }).content[0]?.text ?? '';
      expect(autoPyOutlineText).toContain('only_in_py_repo');
      expect(autoPyOutlineText).toContain('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
    } finally {
      mcp.close();
    }
  });

  it('Pattern 1: demultiplexes composite HTML/Jinja2 (<script>, <style>, landmarks, CALLS_ROUTE, WebMCP), indexes CSS sections, and generates fallback outlines for Markdown/YAML/JSON/TOML', () => {
    const repo = makeTempRepo('web-polyglot');
    fs.writeFileSync(
      path.join(repo, 'pyproject.toml'),
      '[project]\nname = "web-polyglot"\nversion = "0.1.0"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    );
    fs.writeFileSync(
      path.join(repo, 'AGENTS.md'),
      '# Repository Guidelines\n\n## 1. Voice Rules\nAlways write clearly.\n\n## 2. Testing Rules\nAlways run pytest.\n',
    );
    fs.mkdirSync(path.join(repo, 'src', 'static'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src', 'templates'), { recursive: true });

    fs.writeFileSync(
      path.join(repo, 'src', 'static', 'styles.css'),
      `:root {
  --bg-paper: #faf8f5;
  --ink: #1e1e1e;
}

/* === Masthead & Topbar === */
.masthead {
  display: flex;
  justify-content: space-between;
}

.masthead-title {
  font-size: 1.25rem;
}

@media (max-width: 768px) {
  .masthead {
    flex-direction: column;
  }
}
`,
    );

    fs.writeFileSync(
      path.join(repo, 'src', 'templates', 'index.html'),
      `{% extends "base.html" %}
{% block content %}
{# Main Workspace Stream #}
<main id="workspace-stream">
  <section id="chat-drawer">
    <form hx-post="/api/chat/ask">
      <button type="submit">Ask</button>
    </form>
  </section>
</main>
<style>
  /* Drawer inline overrides */
  .drawer-active {
    opacity: 1;
  }
</style>
<script>
  async function submitChatPrompt(promptText) {
    const res = await fetch('/api/chat/stream', { method: 'POST', body: promptText });
    return res.json();
  }

  navigator.modelContext.registerTool({
    name: "search_essays",
    description: "Search published essays",
    execute: async () => ({ ok: true })
  });
</script>
{% endblock %}
`,
    );

    const db = new AstGraphDatabase(path.join(repo, '.ast-graph', 'ast.db'));
    try {
      const indexer = new AstGraphIndexer(repo, db);
      const sync = indexer.syncWorkspace({ full: true });
      expect(sync.totals.files).toBe(2); // styles.css + index.html

      // 1. Verify CSS outline has StylesheetSection, CssAtRule, and selector landmarks
      const cssOutline = db.getFileOutline('src/static/styles.css');
      expect(cssOutline.totalSymbolsInFile).toBeGreaterThanOrEqual(3);
      expect(cssOutline.symbols.some((s) => s.kind === 'StylesheetSection')).toBe(true);
      expect(cssOutline.symbols.some((s) => s.kind === 'CssAtRule' && s.name.includes('@media'))).toBe(true);

      // 2. Verify HTML composite demultiplexing preserves exact 1-based line numbers for <script> functions
      const htmlOutline = db.getFileOutline('src/templates/index.html');
      const submitFn = htmlOutline.symbols.find((s) => s.name === 'submitChatPrompt');
      expect(submitFn).toBeDefined();
      expect(submitFn?.kind).toBe('Function');
      expect(submitFn?.startLine).toBe(18);
      expect(submitFn?.endLine).toBe(21);

      // Verify WebMCP tool registration and DOM/Jinja landmarks
      expect(htmlOutline.symbols.some((s) => s.name === 'webmcp:search_essays')).toBe(true);
      expect(htmlOutline.symbols.some((s) => s.kind === 'TemplateLandmark' && s.name.includes('#workspace-stream'))).toBe(true);

      // Verify CALLS_ROUTE edges from both hx-post and fetch() inside <script>
      const streamLineage = db.getCrossLayerLineage('/api/chat/stream');
      expect(streamLineage.endpointClients.some((e) => e.srcName === 'submitChatPrompt')).toBe(true);
      const hxLineage = db.getCrossLayerLineage('/api/chat/ask');
      expect(hxLineage.endpointClients.length).toBeGreaterThanOrEqual(1);

      // 3. Verify fallback structural outline for Markdown & TOML (never returns 0 symbols)
      const mdOutline = db.getFileOutline('AGENTS.md');
      expect(mdOutline.totalSymbolsInFile).toBe(3);
      expect(mdOutline.symbols[0]?.kind).toBe('DocumentSection');
      expect(mdOutline.symbols.some((s) => s.name.includes('Voice Rules'))).toBe(true);

      const tomlOutline = db.getFileOutline('pyproject.toml');
      expect(tomlOutline.totalSymbolsInFile).toBeGreaterThanOrEqual(2);
      expect(tomlOutline.symbols.some((s) => s.name === '[project]')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('Pattern 2: normalizes MCP parameter aliases, supports batch array polymorphism, and returns didYouMean suggestions on zero-hit queries', () => {
    const repo = makeTempRepo('mcp-polymorphism');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'mcp-polymorphism' }));
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'src', 'engine.ts'),
      `export function calculateTrajectory(velocity: number): number {
  return velocity * 2;
}

export function normalizeHeading(angle: number): number {
  return ((angle % 360) + 360) % 360;
}
`,
    );
    fs.writeFileSync(
      path.join(repo, 'src', 'router.ts'),
      `import { calculateTrajectory } from './engine.js';
export function dispatchRoute(v: number): number {
  return calculateTrajectory(v);
}
`,
    );

    const mcp = new AstMcpServer(repo);
    try {
      // 1. Batch filePaths via `files` alias + `file://` URI with `#L1-L5` anchor on ast_outline
      const outlineRes = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'ast_outline',
          arguments: {
            files: [`file://${path.join(repo, 'src', 'engine.ts')}#L1-L5`, 'src/router.ts'],
            workspace: repo,
          },
        },
      });
      const outlinePayload = (outlineRes?.result as {
        structuredContent: { count: number; outlines: Array<{ filePath: string; totalSymbolsInFile: number }> };
      }).structuredContent;
      expect(outlinePayload.count).toBe(2);
      expect(outlinePayload.outlines[0]?.filePath).toBe('src/engine.ts');
      expect(outlinePayload.outlines[0]?.totalSymbolsInFile).toBeGreaterThanOrEqual(2);
      expect(outlinePayload.outlines[1]?.filePath).toBe('src/router.ts');

      // 2. Batch `symbols` alias on ast_symbol
      const symRes = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'ast_symbol',
          arguments: {
            symbols: ['calculateTrajectory', 'dispatchRoute'],
            workspace: repo,
          },
        },
      });
      const symPayload = (symRes?.result as {
        structuredContent: { count: number; results: Array<{ symbol: { name: string } | null }> };
      }).structuredContent;
      expect(symPayload.count).toBe(2);
      expect(symPayload.results[0]?.symbol?.name).toBe('calculateTrajectory');
      expect(symPayload.results[1]?.symbol?.name).toBe('dispatchRoute');

      // 3. `from` / `to` aliases on ast_shortest_path
      const pathRes = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'ast_shortest_path',
          arguments: {
            from: 'dispatchRoute',
            to: 'calculateTrajectory',
            workspace: repo,
          },
        },
      });
      const pathPayload = (pathRes?.result as {
        structuredContent: { found: boolean; hopCount: number };
      }).structuredContent;
      expect(pathPayload.found).toBe(true);
      expect(pathPayload.hopCount).toBe(1);

      // 4. Zero-hit recovery with didYouMean on ast_search and ast_blast_radius
      const typoRes = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'ast_search',
          arguments: {
            symbol: 'calclateTrajectry',
            workspace: repo,
          },
        },
      });
      const typoPayload = (typoRes?.result as {
        structuredContent: { count: number; didYouMean?: Array<{ name: string }> };
      }).structuredContent;
      expect(typoPayload.count).toBe(0);
      expect(typoPayload.didYouMean?.some((s) => s.name === 'calculateTrajectory')).toBe(true);

      const blastTypoRes = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'ast_blast_radius',
          arguments: {
            symbol: 'calclateTrajectry',
            workspace: repo,
          },
        },
      });
      const blastTypoPayload = (blastTypoRes?.result as {
        structuredContent: { resolvedSymbols: unknown[]; didYouMean?: Array<{ name: string }> };
      }).structuredContent;
      expect(blastTypoPayload.resolvedSymbols.length).toBe(0);
      expect(blastTypoPayload.didYouMean?.some((s) => s.name === 'calculateTrajectory')).toBe(true);
    } finally {
      mcp.close();
    }
  });

  it('Pattern 3: dynamically synthesizes benchmark scenarios and polyglot test discovery on non-TypeScript repositories', () => {
    const repo = makeTempRepo('py-benchmark');
    fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\nname = "py-benchmark"\n');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'src', 'service.py'),
      `from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class EssayQuery(BaseModel):
    topic: str

def score_essay_voice(text: str) -> float:
    words = text.split()
    return float(len(words))

def audit_document(query: EssayQuery) -> float:
    return score_essay_voice(query.topic)

@app.post("/api/audit")
def handle_audit(body: EssayQuery) -> float:
    return audit_document(body)
`,
    );
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'tests', 'test_service.py'),
      `from src.service import audit_document, score_essay_voice, EssayQuery

def test_audit_document():
    res = audit_document(EssayQuery(topic="hello world"))
    assert res == 2.0

def test_score_voice():
    assert score_essay_voice("one two three") == 3.0
`,
    );

    const db = new AstGraphDatabase(path.join(repo, '.ast-graph', 'ast.db'));
    try {
      const indexer = new AstGraphIndexer(repo, db);
      const report = runBenchmark(repo, db, indexer);

      expect(report.indexing.totalFilesIndexed).toBe(2);
      expect(report.queryLatenciesMs.sampleCount).toBe(20);
      expect(report.traceabilityComparisons.length).toBeGreaterThanOrEqual(3);
      for (const sc of report.traceabilityComparisons) {
        expect(sc.resolvedSymbolId).not.toBe('unresolved');
        expect(sc.grepBaseline.fullWorkspaceTestFilesCount).toBeGreaterThanOrEqual(1);
      }
      expect(report.aggregateEfficiency.avgFilesReadReductionRatio).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
