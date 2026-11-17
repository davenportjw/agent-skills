import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { goTypeIdentifiers } from '../src/adapters/go-adapter.js';
import { AstGraphDatabase, AstGraphIndexer } from '../src/index.js';

const tempDirs: string[] = [];

function makeGoRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ast-graph-go-refs-')));
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  tempDirs.push(dir);
  const write = (rel: string, lines: string[]): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), lines.join('\n'));
  };
  write('go.mod', ['module example.com/smartrouter', '', 'go 1.23']);
  // Methods declared in a file that sorts *before* the type declaration (deferred receiver resolution).
  write('router/a_methods.go', [
    'package router',
    '',
    'func (p *RouterProxy) Route(req Request) (*DecisionResult, error) {',
    '  res := &DecisionResult{Model: p.cfg.Default}',
    '  return res, nil',
    '}',
  ]);
  write('router/types.go', [
    'package router',
    '',
    'type (',
    '  Tier string',
    '  Request struct {',
    '    Prompt string',
    '  }',
    ')',
    '',
    'type Config struct {',
    '  Default string',
    '  Tier    Tier',
    '}',
    '',
    'type DecisionResult struct {',
    '  Model string',
    '}',
    '',
    'type RouterProxy struct {',
    '  cfg *Config',
    '}',
    '',
    'type Decider interface {',
    '  Decide(req Request) DecisionResult',
    '}',
  ]);
  write('cmd/main.go', [
    'package main',
    '',
    'import "example.com/smartrouter/router"',
    '',
    'func NewProxy() *router.RouterProxy {',
    '  return &router.RouterProxy{}',
    '}',
  ]);
  write('router/proxy_test.go', [
    'package router',
    '',
    'import "testing"',
    '',
    'func TestRoute(t *testing.T) {',
    '  p := RouterProxy{cfg: &Config{Default: "flash"}}',
    '  _, _ = p.Route(Request{Prompt: "hi"})',
    '}',
  ]);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('Go type references', () => {
  it('extracts type identifiers without picking up value members, strings, or comments', () => {
    const names = (s: string, recv?: string) => goTypeIdentifiers(s, recv).map((t) => t.name);
    expect(names('res := &DecisionResult{Model: p.cfg.Default}', 'p')).toEqual(['res', 'DecisionResult', 'Model']);
    expect(names('return &router.RouterProxy{} // Config')).toEqual(['return', 'RouterProxy']);
    expect(names('log("Config is RouterProxy")')).toEqual(['log']);
    expect(goTypeIdentifiers('x := &Config{}').find((t) => t.name === 'Config')).toMatchObject({
      composite: true,
      typeContext: true,
    });
  });

  it('links Go structs to receivers, composite literals, signatures, fields, and tests', () => {
    const repo = makeGoRepo();
    const db = new AstGraphDatabase(path.join(repo, '.ast-graph', 'ast.db'));
    try {
      new AstGraphIndexer(repo, db).syncWorkspace({ full: true });

      const proxyRefs = db.getSymbolReferences('RouterProxy', { limit: 50 });
      expect(proxyRefs.resolvedSymbols.length).toBeGreaterThan(0);
      const proxyRefFiles = proxyRefs.references.map((r) => r.srcFilePath);
      expect(proxyRefFiles).toContain('cmd/main.go'); // cross-package composite literal + return type
      expect(proxyRefFiles).toContain('router/proxy_test.go');

      const decision = db.getSymbolNeighborhood('DecisionResult', { limit: 50 });
      const callerNames = decision.callers.map((c) => c.srcName);
      expect(callerNames.join(' ')).toMatch(/Route/);
      expect(callerNames.join(' ')).toMatch(/Decide/); // interface method signature

      const config = db.getSymbolNeighborhood('Config', { limit: 50 });
      expect(config.callers.length).toBeGreaterThan(0); // RouterProxy.cfg field type + test literal

      // Receiver methods are contained by their type even when declared in an earlier-sorted file.
      const proxy = db.getSymbolNeighborhood('RouterProxy', { limit: 50 });
      const raw = new DatabaseSync(path.join(repo, '.ast-graph', 'ast.db'), { readOnly: true });
      const containsRoute = raw
        .prepare(`SELECT COUNT(*) AS c FROM edges WHERE kind = 'CONTAINS' AND src_id = ? AND dst_id LIKE '%RouterProxy#Route().'`)
        .get(proxy.symbol!.id) as { c: number };
      raw.close();
      expect(containsRoute.c).toBe(1);
      expect(proxy.coveringTests.map((t) => t.testName)).toContain('TestRoute');

      // Grouped `type ( ... )` specs are indexed, and struct fields are not mistaken for types.
      expect(db.resolveTargetSymbols('Tier', 5, { exactOnly: true }).length).toBeGreaterThan(0);
      expect(db.resolveTargetSymbols('Request', 5, { exactOnly: true }).length).toBeGreaterThan(0);
      expect(db.resolveTargetSymbols('Prompt', 5, { exactOnly: true }).every((s) => s.kind === 'Property')).toBe(true);
    } finally {
      db.close();
    }
  });
});
