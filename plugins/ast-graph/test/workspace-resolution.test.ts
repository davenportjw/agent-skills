import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AstMcpServer, PLUGIN_ROOT, isPluginInstallDir } from '../src/mcp.js';

// Isolate from the developer's real ~/GitHub repos and global registry so no real index is opened.
let fakeHome = '';
let realHome: string | undefined;
const tempDirs: string[] = [];

beforeEach(() => {
  realHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-graph-home-'));
  tempDirs.push(fakeHome);
  process.env.HOME = fakeHome;
});
afterEach(() => {
  process.env.HOME = realHome;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepo(name: string): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)));
  tempDirs.push(repo);
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name, type: 'module' }));
  fs.writeFileSync(
    path.join(repo, 'src', 'thing.ts'),
    'export function rootsResolvedFunction(x: number): number {\n  return x + 1;\n}\n',
  );
  return repo;
}

function callTool(mcp: AstMcpServer, name: string, args: Record<string, unknown>) {
  const res = mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return res?.result as { isError: boolean; content: Array<{ text: string }>; structuredContent?: { workspaceRoot?: string } };
}

describe('workspace resolution', () => {
  it('detects the plugin install dir and harness plugin caches', () => {
    expect(isPluginInstallDir(PLUGIN_ROOT)).toBe(true);
    expect(isPluginInstallDir(path.join(PLUGIN_ROOT, 'dist'))).toBe(true);
    expect(isPluginInstallDir(path.join(fakeHome, '.claude', 'plugins', 'cache', 'x'))).toBe(true);
    expect(isPluginInstallDir(makeRepo('user-repo'))).toBe(false);
  });

  it('never falls back to the plugin directory; returns NO_WORKSPACE instead', () => {
    const pluginDb = path.join(PLUGIN_ROOT, '.ast-graph', 'ast.db');
    const before = fs.existsSync(pluginDb) ? fs.statSync(pluginDb).mtimeMs : null;
    const mcp = new AstMcpServer(PLUGIN_ROOT);
    try {
      expect(mcp.defaultWorkspaceRoot).toBeNull();
      const res = callTool(mcp, 'ast_search', { query: 'zzqNoSuchSymbolAnywhere' });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/NO_WORKSPACE/);
      const after = fs.existsSync(pluginDb) ? fs.statSync(pluginDb).mtimeMs : null;
      expect(after).toBe(before);
    } finally {
      mcp.close();
    }
  });

  it('rejects an unknown explicit workspace instead of silently using the default', () => {
    const repo = makeRepo('explicit-default');
    const mcp = new AstMcpServer(repo);
    try {
      const res = callTool(mcp, 'ast_search', { query: 'rootsResolvedFunction', workspace: 'does-not-exist-repo' });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/UNKNOWN_WORKSPACE/);
    } finally {
      mcp.close();
    }
  });

  it('uses MCP client roots (roots/list) as the default workspace', () => {
    const repo = makeRepo('client-root');
    const mcp = new AstMcpServer(PLUGIN_ROOT);
    const outbound: Array<Record<string, unknown>> = [];
    mcp.sendToClient = (msg) => outbound.push(msg);
    try {
      mcp.handleRequest({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { capabilities: { roots: { listChanged: true } } },
      });
      expect(mcp.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
      expect(outbound).toHaveLength(1);
      expect(outbound[0]?.method).toBe('roots/list');

      // Client answers the server-initiated request; plugin-dir roots are ignored.
      const reply = {
        jsonrpc: '2.0',
        id: outbound[0]!.id,
        result: { roots: [{ uri: pathToFileURL(PLUGIN_ROOT).href }, { uri: pathToFileURL(repo).href }] },
      };
      expect(mcp.handleRequest(reply as never)).toBeNull();
      expect(mcp.getClientRoots()).toEqual([repo]);

      const res = callTool(mcp, 'ast_search', { query: 'rootsResolvedFunction' });
      expect(res.isError).toBe(false);
      expect(res.structuredContent?.workspaceRoot).toBe(repo);
      expect(res.content[0]?.text).toContain('rootsResolvedFunction');
    } finally {
      mcp.close();
    }
  });

  it('a single client root with a never-synced index wins over another indexed repo with the same symbol', () => {
    const rootRepo = makeRepo('client-root-unsynced');
    const otherRepo = makeRepo('other-indexed');
    const mcp = new AstMcpServer(PLUGIN_ROOT);
    try {
      // Index the other repo so it is a live, populated candidate in the pool.
      expect(callTool(mcp, 'ast_sync', { workspace: otherRepo, full: true }).isError).toBe(false);
      mcp.setClientRoots([pathToFileURL(rootRepo).href]);
      const res = callTool(mcp, 'ast_search', { query: 'rootsResolvedFunction' });
      expect(res.isError).toBe(false);
      expect(res.structuredContent?.workspaceRoot).toBe(rootRepo);
    } finally {
      mcp.close();
    }
  });

  it('does not request roots when the client did not advertise the capability', () => {
    const mcp = new AstMcpServer(PLUGIN_ROOT);
    const outbound: Array<Record<string, unknown>> = [];
    mcp.sendToClient = (msg) => outbound.push(msg);
    try {
      mcp.handleRequest({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {} } });
      mcp.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(outbound).toHaveLength(0);
    } finally {
      mcp.close();
    }
  });
});
