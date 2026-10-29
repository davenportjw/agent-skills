import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INLINE_BYTE_BUDGET,
  SUMMARY_MARKER,
  enforceInlineSizeCap,
  formatCompactCliOutput,
  moveSummaryFirst,
} from '../src/cli.js';
import { isPublicMember } from '../src/adapters/ts-adapter.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function fakeMatch(i: number, file = `src/module-${i % 3}.ts`) {
  return {
    name: `symbolNumber${i}`,
    kind: 'Function',
    exported: true,
    filePath: file,
    startLine: i * 10,
    endLine: i * 10 + 5,
    signature: `export function symbolNumber${i}(argumentOne: string, argumentTwo: number): Promise<void>`,
  };
}

describe('compact output budget (efficacy review: inline spill avoidance)', () => {
  it('hoists the summary block directly under the header line', () => {
    const text = ['HEADER', '  detail 1', '  detail 2', '', SUMMARY_MARKER, 'Top: x'].join('\n');
    const out = moveSummaryFirst(text).split('\n');
    expect(out[0]).toBe('HEADER');
    expect(out[1]).toBe(SUMMARY_MARKER);
    expect(out[2]).toBe('Top: x');
    expect(out).toContain('  detail 2');
  });

  it('keeps large search results under the byte budget with the summary intact', () => {
    const matches = Array.from({ length: 200 }, (_, i) => fakeMatch(i));
    const out = formatCompactCliOutput('search', { query: 'symbolNumber', matches }, 'symbolNumber', {
      tee: false,
    });
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(INLINE_BYTE_BUDGET);
    expect(out.split('\n')[1]).toBe(SUMMARY_MARKER);
    expect(out).toContain('Recommended Action: view_file on src/module-0.ts');
    expect(out).toMatch(/more lines omitted to stay inline/);
  });

  it('groups search hits by file so each path is printed once', () => {
    const matches = [fakeMatch(1, 'a.ts'), fakeMatch(2, 'a.ts'), fakeMatch(3, 'b.ts')];
    const out = formatCompactCliOutput('search', { query: 'symbol', matches }, 'symbol', { tee: false });
    expect(out.match(/^ {2}a\.ts$/gm)?.length).toBe(1);
    expect(out).toContain('    L10-L15 symbolNumber1');
  });

  it('prints the outline file path once instead of on every line', () => {
    const symbols = Array.from({ length: 5 }, (_, i) => fakeMatch(i, 'src/big.ts'));
    const out = formatCompactCliOutput(
      'outline',
      { filePath: 'src/big.ts', symbols, totalSymbolsInFile: 5, matchedSymbolsCount: 5, lineCount: 100 },
      'src/big.ts',
      { tee: false },
    );
    expect(out.match(/src\/big\.ts#L/g)?.length ?? 0).toBeLessThanOrEqual(2); // summary only
    expect(out).toContain('  L0-L5 [Function exp] symbolNumber0');
  });

  it('explains not-indexed files instead of silently returning zero symbols', () => {
    const out = formatCompactCliOutput(
      'outline',
      { filePath: null, query: 'apps/server.ts', symbols: [], totalSymbolsInFile: 0, matchedSymbolsCount: 0 },
      'apps/server.ts',
      { tee: false },
    );
    expect(out).toContain('NOT INDEXED');
    expect(out).toContain('ast_sync');
  });

  it('routes literal / UI-copy queries to grep and suppresses junk suggestions', () => {
    const out = formatCompactCliOutput(
      'search',
      { query: 'Mission Briefing', matches: [], didYouMean: [fakeMatch(9)] },
      'Mission Briefing',
      { tee: false },
    );
    expect(out).toContain('grep -rn "Mission Briefing"');
    expect(out).not.toContain('symbolNumber9');
  });

  it('lists kinds present in the repo when a kind filter matches nothing', () => {
    const out = formatCompactCliOutput(
      'search',
      { query: '', kind: 'sql_table', matches: [], availableKinds: [{ kind: 'Function', count: 12 }] },
      '',
      { tee: false },
    );
    expect(out).toContain('Kinds present in this repo: Function(12)');
  });

  it('budgets batch results per item so every target keeps its summary', () => {
    const results = ['alpha', 'beta', 'gamma'].map((q) => ({
      query: q,
      matches: Array.from({ length: 60 }, (_, i) => fakeMatch(i)),
    }));
    const out = formatCompactCliOutput('search', { results }, '', { tee: false });
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(INLINE_BYTE_BUDGET + 200);
    expect(out.match(new RegExp(SUMMARY_MARKER, 'g'))?.length).toBe(3);
  });

  it('tees the untruncated output to <repo>/.ast-graph/last and references it in the footer', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-graph-tee-'));
    tempDirs.push(repo);
    fs.mkdirSync(path.join(repo, '.ast-graph'));
    const matches = Array.from({ length: 200 }, (_, i) => fakeMatch(i));
    const out = formatCompactCliOutput('search', { workspaceRoot: repo, query: 's', matches }, 's');
    const teePath = path.join(repo, '.ast-graph', 'last', 'search.txt');
    expect(out).toContain(`full output: ${teePath}`);
    expect(fs.readFileSync(teePath, 'utf8')).toContain('symbolNumber199');
  });

  it('never cuts mid-line and returns short text untouched', () => {
    expect(enforceInlineSizeCap('short')).toBe('short');
    const long = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n');
    const capped = enforceInlineSizeCap(long, 400);
    for (const line of capped.split('\n').slice(0, -1)) expect(line).toMatch(/^line-\d+$/);
  });
});

describe('TypeScript member visibility', () => {
  function members(src: string): Map<string, boolean> {
    const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true);
    const out = new Map<string, boolean>();
    const visit = (n: ts.Node) => {
      if ((ts.isPropertyDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
        out.set(n.name.getText(sf), isPublicMember(n));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }

  it('marks private, protected and #private members as not exported', () => {
    const m = members(
      'export class A { private readonly db = 1; protected p = 2; #h = 3; pub = 4; private m() {} run() {} }',
    );
    expect(m.get('db')).toBe(false);
    expect(m.get('p')).toBe(false);
    expect(m.get('#h')).toBe(false);
    expect(m.get('m')).toBe(false);
    expect(m.get('pub')).toBe(true);
    expect(m.get('run')).toBe(true);
  });
});
