import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { AstGraphDatabase } from './db.js';
import { AstGraphIndexer } from './indexer.js';
import { analyzeGraph, runBenchmark } from './analyzer.js';

export interface CliExecutionOptions {
  workspaceRoot?: string;
  dbPath?: string;
  useDaemon?: boolean;
  daemonHost?: string;
  daemonPort?: number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4319;

async function fetchDaemonJson<T>(
  method: 'GET' | 'POST',
  endpointPath: string,
  body?: Record<string, unknown>,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  connectTimeoutMs = 50,
  responseTimeoutMs = 2500,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const finish = (val: T | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: host,
        port,
        path: endpointPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
          res.resume();
          finish(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            finish(JSON.parse(text) as T);
          } catch {
            finish(null);
          }
        });
      },
    );

    const connectTimer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, connectTimeoutMs);

    req.on('socket', (socket) => {
      if (!socket.connecting) {
        clearTimeout(connectTimer);
        req.setTimeout(responseTimeoutMs);
        return;
      }
      socket.once('connect', () => {
        clearTimeout(connectTimer);
        req.setTimeout(responseTimeoutMs);
      });
    });

    req.on('timeout', () => {
      clearTimeout(connectTimer);
      req.destroy();
      finish(null);
    });
    req.on('error', () => {
      clearTimeout(connectTimer);
      finish(null);
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  const eqPrefix = `${flag}=`;
  const eqMatch = args.find((arg) => arg.startsWith(eqPrefix));
  if (eqMatch) {
    return eqMatch.slice(eqPrefix.length);
  }
  return undefined;
}

function oneLine(text: string | null | undefined, maxLen = 110): string {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen - 3)}...` : collapsed;
}

export function formatCompactCliOutput(command: string, data: unknown, queryArg = ''): string {
  const rec = (data ?? {}) as Record<string, unknown>;

  if (Array.isArray(rec.batchItems)) {
    const items = rec.batchItems as Array<{ target: string; result: unknown }>;
    return items
      .map((item, idx) =>
        `### [${idx + 1}/${items.length}] Target: ${item.target}\n${formatCompactCliOutput(command, item.result, item.target)}`,
      )
      .join('\n\n');
  }

  if (command === 'refs' || command === 'references') {
    const targetLabel = String(rec.target ?? queryArg);
    const resolvedSymbols = (rec.resolvedSymbols as Array<Record<string, unknown>> | undefined) ?? [];
    const writes = (rec.writes as Array<Record<string, unknown>> | undefined) ?? [];
    const reads = (rec.reads as Array<Record<string, unknown>> | undefined) ?? [];
    const refs = (rec.references as Array<Record<string, unknown>> | undefined) ?? [];
    const totalWrites = Number(rec.totalWritesCount ?? writes.length);
    const totalReads = Number(rec.totalReadsCount ?? reads.length);
    const totalRefs = Number(rec.totalReferencesCount ?? refs.length);

    const lines: string[] = [
      `[AST REFERENCES] target="${targetLabel}" (writes=${totalWrites}, reads=${totalReads}, otherRefs=${totalRefs})`,
    ];
    if (resolvedSymbols.length > 0) {
      lines.push(`Declarations (${Math.min(resolvedSymbols.length, 10)} shown of ${resolvedSymbols.length}):`);
      for (const sym of resolvedSymbols.slice(0, 10)) {
        lines.push(
          `  - ${sym.qualifiedName ?? sym.name} (${sym.kind}) -> ${sym.filePath}#L${sym.startLine}-L${sym.endLine} | ${oneLine(String(sym.signature ?? sym.name), 90)}`,
        );
      }
    } else {
      lines.push('Declarations: none found');
    }

    lines.push(`WRITES_PROPERTY (${Math.min(writes.length, 25)} shown of ${totalWrites}):`);
    for (const w of writes.slice(0, 25)) {
      lines.push(
        `  - [WRITE] ${w.callSiteFile}#L${w.callSiteLine} inside ${w.srcName} (${w.srcKind}, L${w.srcStartLine}-L${w.srcEndLine})`,
      );
    }

    lines.push(`READS_PROPERTY (${Math.min(reads.length, 25)} shown of ${totalReads}):`);
    for (const r of reads.slice(0, 25)) {
      lines.push(
        `  - [READ]  ${r.callSiteFile}#L${r.callSiteLine} inside ${r.srcName} (${r.srcKind}, L${r.srcStartLine}-L${r.srcEndLine})`,
      );
    }

    if (refs.length > 0) {
      lines.push(`Other References (${Math.min(refs.length, 15)} shown of ${totalRefs}):`);
      for (const ref of refs.slice(0, 15)) {
        lines.push(
          `  - [${ref.edgeKind}] ${ref.callSiteFile}#L${ref.callSiteLine} inside ${ref.srcName} (${ref.srcKind}, L${ref.srcStartLine}-L${ref.srcEndLine})`,
        );
      }
    }

    lines.push('');
    lines.push('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
    lines.push(`Target Property/Symbol: ${targetLabel} (writes=${totalWrites}, reads=${totalReads})`);
    if (resolvedSymbols[0]) {
      const top = resolvedSymbols[0];
      lines.push(`Primary Declaration: ${top.qualifiedName ?? top.name} (${top.kind}) at ${top.filePath}#L${top.startLine}-L${top.endLine}`);
    }
    if (writes.length > 0) {
      lines.push(
        `Write Sites: ${writes
          .slice(0, 8)
          .map((w) => `${w.callSiteFile}#L${w.callSiteLine} (${w.srcName})`)
          .join(', ')}`,
      );
    }
    if (reads.length > 0) {
      lines.push(
        `Read Sites: ${reads
          .slice(0, 8)
          .map((r) => `${r.callSiteFile}#L${r.callSiteLine} (${r.srcName})`)
          .join(', ')}`,
      );
    }
    const primaryFocus = writes[0] ?? reads[0];
    if (primaryFocus) {
      lines.push(
        `Recommended Action: view_file on ${primaryFocus.callSiteFile} with StartLine=${primaryFocus.srcStartLine}, EndLine=${primaryFocus.srcEndLine}`,
      );
    }
    return lines.join('\n');
  }

  if (command === 'symbol') {
    if ('symbol' in rec) {
      const sym = rec.symbol as Record<string, unknown> | null;
      const callers = (rec.callers as Array<Record<string, unknown>> | undefined) ?? [];
      const callees = (rec.callees as Array<Record<string, unknown>> | undefined) ?? [];
      const coveringTests = (rec.coveringTests as Array<Record<string, unknown>> | undefined) ?? [];
      const matches = (rec.matches as Array<Record<string, unknown>> | undefined) ?? [];
      const totalCallers = Number(rec.totalCallersCount ?? callers.length);
      const totalCallees = Number(rec.totalCalleesCount ?? callees.length);
      const totalTests = Number(rec.totalCoveringTestsCount ?? coveringTests.length);
      const queryLabel = String(rec.query ?? queryArg);

      if (!sym) {
        const lines: string[] = [
          `[AST SYMBOL] No exact symbol match for "${queryLabel}". Showing ${Math.min(matches.length, 25)} closest suggestions:`,
        ];
        for (const m of matches.slice(0, 25)) {
          lines.push(
            `  - ${m.name} (${m.kind}${m.exported ? ', exported' : ''}) -> ${m.filePath}#L${m.startLine}-L${m.endLine} | ${oneLine(String(m.signature ?? m.name), 90)}`,
          );
        }
        const top = matches[0];
        lines.push('');
        lines.push('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
        lines.push(`Query: "${queryLabel}" (No exact match; ${matches.length} symbol suggestions above)`);
        if (top) {
          lines.push(`Top Suggestion: ${top.name} (${top.kind}) at ${top.filePath}#L${top.startLine}-L${top.endLine}`);
          lines.push(
            `Recommended Action: view_file on ${top.filePath} with StartLine=${top.startLine}, EndLine=${top.endLine}`,
          );
        } else {
          lines.push('Recommended Action: Run `npm run ast:query -- outline <filePath>` or `npm run ast:query -- search <keyword>`');
        }
        return lines.join('\n');
      }

      const lines: string[] = [
        `[AST SYMBOL] ${sym.name} (${sym.kind}${sym.exported ? ', exported' : ''})`,
        `Location: ${sym.filePath}#L${sym.startLine}-L${sym.endLine} (${sym.packageName})`,
        `Signature: ${oneLine(String(sym.signature ?? sym.name), 120)}`,
      ];
      if (sym.docstring) {
        lines.push(`Doc: ${oneLine(String(sym.docstring), 120)}`);
      }
      lines.push(`Callers (${Math.min(callers.length, 15)} shown of ${totalCallers}):`);
      for (const c of callers.slice(0, 15)) {
        const callerName = c.srcName ?? c.name;
        const callerKind = c.srcKind ?? c.kind;
        const callerFile = c.srcFilePath ?? c.filePath;
        const callerLine = c.srcLine ?? c.startLine;
        lines.push(`  - ${callerName} (${callerKind}) -> ${callerFile}#L${callerLine} (callSite L${c.callSiteLine ?? callerLine})`);
      }
      lines.push(`Callees (${Math.min(callees.length, 15)} shown of ${totalCallees}):`);
      for (const c of callees.slice(0, 15)) {
        const calleeName = c.dstName ?? c.name;
        const calleeKind = c.dstKind ?? c.kind;
        const calleeFile = c.dstFilePath ?? c.filePath;
        const calleeLine = c.dstLine ?? c.startLine;
        lines.push(`  - ${calleeName} (${calleeKind}) -> ${calleeFile}#L${calleeLine} (callSite L${c.callSiteLine ?? calleeLine})`);
      }
      lines.push(`Covering Tests (${Math.min(coveringTests.length, 10)} shown of ${totalTests}):`);
      for (const t of coveringTests.slice(0, 10)) {
        const testKind = t.testKind ?? t.kind;
        const testName = t.testName ?? t.name;
        lines.push(`  - [${testKind}] ${testName} -> ${t.filePath}#L${t.startLine}-L${t.endLine}`);
      }
      lines.push('');
      lines.push('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
      lines.push(`Target Symbol: ${sym.name} (${sym.kind})`);
      lines.push(`Exact Location: ${sym.filePath}#L${sym.startLine}-L${sym.endLine}`);
      lines.push(`Signature: ${oneLine(String(sym.signature ?? sym.name), 120)}`);
      lines.push(
        `Recommended Action: view_file on ${sym.filePath} with StartLine=${sym.startLine}, EndLine=${sym.endLine}`,
      );
      return lines.join('\n');
    }
  }

  if (command === 'outline') {
    const filePath = (rec.filePath as string | null) ?? String(rec.query ?? queryArg);
    const symbols = (rec.symbols as Array<Record<string, unknown>> | undefined) ?? [];
    const totalSymbols = Number(rec.totalSymbolsInFile ?? rec.totalSymbols ?? symbols.length);
    const matchedCount = Number(rec.matchedSymbolsCount ?? symbols.length);
    const lines: string[] = [
      `[AST FILE OUTLINE] ${filePath} (${Math.min(symbols.length, 55)} shown of ${matchedCount} matched / ${totalSymbols} total symbols in ${rec.lineCount ?? '?'} lines)`,
    ];
    for (const s of symbols.slice(0, 55)) {
      lines.push(
        `  ${filePath}#L${s.startLine}-L${s.endLine} | [${s.kind}${s.exported ? ' exp' : ''}] ${s.name} :: ${oneLine(String(s.signature ?? s.name), 95)}`,
      );
    }
    const first = symbols[0];
    lines.push('');
    lines.push('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
    lines.push(`File Outline: ${filePath} (${matchedCount}/${totalSymbols} symbols matched)`);
    if (first) {
      lines.push(`First Matched Symbol: ${first.name} (${first.kind}) at ${filePath}#L${first.startLine}-L${first.endLine}`);
      lines.push(
        `Recommended Action: view_file on ${filePath} with StartLine=${first.startLine}, EndLine=${first.endLine}`,
      );
    } else {
      lines.push('Recommended Action: Try a broader --filter or omit --kind');
    }
    return lines.join('\n');
  }

  if (command === 'search' || (command === 'symbol' && 'matches' in rec && !('symbol' in rec))) {
    const matches = (rec.matches as Array<Record<string, unknown>> | undefined) ?? [];
    const q = String(rec.query ?? queryArg);
    const lines: string[] = [
      `[AST SEARCH] query="${q}"${rec.kind ? ` kind=${rec.kind}` : ''} (${Math.min(matches.length, 40)} shown of ${matches.length} matches)`,
    ];
    for (const m of matches.slice(0, 40)) {
      lines.push(
        `  - ${m.name} (${m.kind}${m.exported ? ', exported' : ''}) -> ${m.filePath}#L${m.startLine}-L${m.endLine} | ${oneLine(String(m.signature ?? m.name), 90)}`,
      );
    }
    const top = matches[0];
    lines.push('');
    lines.push('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
    lines.push(`Search Query: "${q}" (${matches.length} matches)`);
    if (top) {
      lines.push(`Top Match: ${top.name} (${top.kind}) at ${top.filePath}#L${top.startLine}-L${top.endLine}`);
      lines.push(
        `Recommended Action: view_file on ${top.filePath} with StartLine=${top.startLine}, EndLine=${top.endLine}`,
      );
    } else {
      lines.push('Recommended Action: Try `npm run ast:query -- outline <filePath>`');
    }
    return lines.join('\n');
  }

  if (command === 'blast-radius') {
    const resolvedSymbols = (rec.resolvedSymbols as Array<Record<string, unknown>> | undefined) ?? [];
    const impactedNodes = (rec.impactedNodes as Array<Record<string, unknown>> | undefined) ?? [];
    const impactedFiles = (rec.impactedFiles as Array<Record<string, unknown>> | undefined) ?? [];
    const impactedPackages = (rec.impactedPackages as string[] | undefined) ?? [];
    const recommendedTests = (rec.recommendedTests as Array<Record<string, unknown>> | undefined) ?? [];
    const vitestCmd = String(rec.vitestCommand ?? 'npm test');
    const focal = resolvedSymbols[0];

    const lines: string[] = [
      `[AST BLAST RADIUS] target="${String(rec.target ?? queryArg)}" (maxHops=${rec.maxHops ?? 3}, impactedNodes=${impactedNodes.length}, impactedFiles=${impactedFiles.length})`,
    ];
    if (focal) {
      lines.push(`Resolved Target: ${focal.name} (${focal.kind}) -> ${focal.filePath}#L${focal.startLine}-L${focal.endLine}`);
    }
    lines.push(`Impacted Packages (${impactedPackages.length}): ${impactedPackages.join(', ') || 'none'}`);
    lines.push(`Impacted Symbols (${Math.min(impactedNodes.length, 30)} shown of ${impactedNodes.length}):`);
    for (const item of impactedNodes.slice(0, 30)) {
      lines.push(
        `  [hop ${item.hopDistance ?? 1} via ${item.viaEdgeKind}] ${item.name} (${item.kind}) -> ${item.filePath}#L${item.startLine}-L${item.endLine}`,
      );
    }
    const testFiles = recommendedTests.map((t) => String(t.testFilePath));
    lines.push(`Covering Test Files (${testFiles.length}): ${testFiles.join(', ') || 'none'}`);
    lines.push('');
    lines.push('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
    lines.push(
      `Blast Radius Target: ${String(rec.target ?? queryArg)} (${impactedNodes.length} impacted symbols across ${impactedFiles.length} files)`,
    );
    if (focal) {
      lines.push(`Target Location: ${focal.filePath}#L${focal.startLine}-L${focal.endLine}`);
    }
    lines.push(`Impacted Packages: ${impactedPackages.join(', ') || 'none'}`);
    lines.push(`Recommended Test Command: ${vitestCmd}`);
    return lines.join('\n');
  }

  if (command === 'tests-for') {
    const testFiles = (rec.testFiles as string[] | undefined) ?? [];
    const directTests = (rec.directTests as Array<Record<string, unknown>> | undefined) ?? [];
    const transitiveTests = (rec.transitiveTests as Array<Record<string, unknown>> | undefined) ?? [];
    const vitestCmd = String(rec.vitestCommand ?? 'npm test');

    const lines: string[] = [
      `[AST TESTS FOR] target="${String(rec.target ?? queryArg)}" (${testFiles.length} test files, ${directTests.length} direct, ${transitiveTests.length} transitive)`,
      `Test Files: ${testFiles.join(', ') || 'none'}`,
      `Direct Tests (${Math.min(directTests.length, 20)} shown of ${directTests.length}):`,
    ];
    for (const t of directTests.slice(0, 20)) {
      lines.push(`  - [${t.kind}] ${t.name} -> ${t.filePath}#L${t.startLine}-L${t.endLine}`);
    }
    if (transitiveTests.length > 0) {
      lines.push(`Transitive Tests (${Math.min(transitiveTests.length, 15)} shown of ${transitiveTests.length}):`);
      for (const t of transitiveTests.slice(0, 15)) {
        lines.push(`  - [${t.kind}] ${t.name} -> ${t.filePath}#L${t.startLine}-L${t.endLine}`);
      }
    }
    lines.push('');
    lines.push('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
    lines.push(`Target: ${String(rec.target ?? queryArg)} (${testFiles.length} covering test files)`);
    lines.push(`Recommended Test Command: ${vitestCmd}`);
    return lines.join('\n');
  }

  if (command === 'callers' || command === 'callees') {
    const sym = rec.resolvedSymbol as Record<string, unknown> | null;
    const list = (rec[command] as Array<Record<string, unknown>> | undefined) ?? [];
    const total = Number(
      (command === 'callers' ? rec.totalCallersCount : rec.totalCalleesCount) ?? list.length,
    );
    const lines: string[] = [
      `[AST ${command.toUpperCase()}] symbol="${String(rec.symbol ?? queryArg)}" (${Math.min(list.length, 35)} shown of ${total})`,
    ];
    for (const item of list.slice(0, 35)) {
      const name = command === 'callers' ? item.srcName : item.dstName;
      const kind = command === 'callers' ? item.srcKind : item.dstKind;
      const file = command === 'callers' ? item.srcFilePath : item.dstFilePath;
      const line = command === 'callers' ? item.srcLine : item.dstLine;
      lines.push(`  - ${name} (${kind}) -> ${file}#L${line} (callSite L${item.callSiteLine ?? line})`);
    }
    lines.push('');
    lines.push('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
    if (sym) {
      lines.push(`Target Symbol: ${sym.name} (${sym.kind}) at ${sym.filePath}#L${sym.startLine}-L${sym.endLine}`);
    } else {
      lines.push(`Target Symbol: ${String(rec.symbol ?? queryArg)} (unresolved)`);
    }
    lines.push(`Total ${command}: ${total}`);
    return lines.join('\n');
  }

  if (command === 'lineage') {
    const focalNodes = (rec.focalNodes as Array<Record<string, unknown>> | undefined) ?? [];
    const validators = (rec.validators as Array<Record<string, unknown>> | undefined) ?? [];
    const emitters = (rec.emitters as Array<Record<string, unknown>> | undefined) ?? [];
    const routesHandled = (rec.routesHandled as Array<Record<string, unknown>> | undefined) ?? [];
    const endpointClients = (rec.endpointClients as Array<Record<string, unknown>> | undefined) ?? [];
    const infraProvisions = (rec.infraProvisions as Array<Record<string, unknown>> | undefined) ?? [];
    const downstreamConsumers = (rec.downstreamConsumers as Array<Record<string, unknown>> | undefined) ?? [];
    const focal = focalNodes[0];

    const lines: string[] = [`[AST LINEAGE] target="${String(rec.target ?? queryArg)}"`];
    if (focal) {
      lines.push(`Focal Symbol: ${focal.name} (${focal.kind}) -> ${focal.filePath}#L${focal.startLine}-L${focal.endLine}`);
    }
    const addEdges = (label: string, items: Array<Record<string, unknown>>) => {
      if (items.length === 0) return;
      lines.push(`${label} (${Math.min(items.length, 8)} shown of ${items.length}):`);
      for (const e of items.slice(0, 8)) {
        lines.push(`  - ${e.srcName} -> ${e.dstName} [${e.edgeKind}] (${e.callSiteFile}#L${e.callSiteLine})`);
      }
    };
    addEdges('Validators', validators);
    addEdges('Emitters', emitters);
    addEdges('Routes Handled', routesHandled);
    addEdges('Endpoint Clients', endpointClients);
    addEdges('Infra Provisions', infraProvisions);
    addEdges('Downstream Consumers', downstreamConsumers);
    lines.push('');
    lines.push('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
    lines.push(
      `Lineage Target: ${String(rec.target ?? queryArg)} (validators=${validators.length}, routes=${routesHandled.length}, clients=${endpointClients.length}, infra=${infraProvisions.length}, consumers=${downstreamConsumers.length})`,
    );
    if (focal) {
      lines.push(`Root Location: ${focal.filePath}#L${focal.startLine}-L${focal.endLine}`);
    }
    return lines.join('\n');
  }

  if (command === 'path') {
    const steps = (rec.path as Array<Record<string, unknown>> | undefined) ?? [];
    const lines: string[] = [
      `[AST SHORTEST PATH] from="${String(rec.fromTarget ?? '')}" to="${String(rec.toTarget ?? '')}" (found=${Boolean(rec.found)}, hops=${rec.hopCount ?? steps.length})`,
    ];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      lines.push(
        `  ${i + 1}. ${s.fromName} (${s.fromFile}) --[${s.edgeKind}]--> ${s.toName} (${s.toFile}#L${s.line})`,
      );
    }
    lines.push('');
    lines.push('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
    lines.push(
      `Shortest Path: ${String(rec.fromTarget ?? '')} -> ${String(rec.toTarget ?? '')} (found=${Boolean(rec.found)}, hops=${rec.hopCount ?? steps.length})`,
    );
    return lines.join('\n');
  }

  return JSON.stringify(data, null, 2);
}

function getPositionalArgs(args: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      if (
        (arg === '--depth' ||
          arg === '--hops' ||
          arg === '--kind' ||
          arg === '--limit' ||
          arg === '--filter' ||
          arg === '--format' ||
          arg === '--db') &&
        i + 1 < args.length
      ) {
        i++;
      }
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

export async function executeCliCommand(
  rawArgs: string[],
  options?: CliExecutionOptions,
): Promise<{ exitCode: number; output: string; data: unknown }> {
  const positionals = getPositionalArgs(rawArgs);
  const command = (positionals[0] ?? 'status').toLowerCase();
  const rawTargets = positionals
    .slice(1)
    .flatMap((t) => (command === 'path' ? [t] : t.split(',')))
    .map((t) => t.trim())
    .filter(Boolean);
  const primaryTarget = rawTargets[0] ?? '';
  const rawJson = rawArgs.includes('--raw-json') || rawArgs.includes('--json');
  const workspaceRoot = path.resolve(options?.workspaceRoot ?? process.cwd());
  const dbFlag = parseFlagValue(rawArgs, '--db');
  const dbPath =
    options?.dbPath ??
    (dbFlag ? path.resolve(workspaceRoot, dbFlag) : path.join(workspaceRoot, '.ast-graph', 'ast.db'));
  const useDaemon = options?.useDaemon !== false && !dbFlag;
  const host = options?.daemonHost ?? DEFAULT_HOST;
  const port = options?.daemonPort ?? DEFAULT_PORT;

  const formatOut = (cmd: string, payload: unknown): string =>
    rawJson ? JSON.stringify(payload, null, 2) : formatCompactCliOutput(cmd, payload, primaryTarget);

  // Try daemon first if allowed and command is supported over HTTP (for single-target queries)
  if (useDaemon && rawTargets.length <= 1) {
    if (command === 'status') {
      const daemonHealth = await fetchDaemonJson<Record<string, unknown>>('GET', '/health', undefined, host, port);
      if (daemonHealth) {
        const output = JSON.stringify({ mode: 'daemon', ...daemonHealth }, null, 2);
        return { exitCode: 0, output, data: daemonHealth };
      }
    } else if (command === 'symbol') {
      const query = primaryTarget;
      const kind = parseFlagValue(rawArgs, '--kind') ?? '';
      const limit = parseFlagValue(rawArgs, '--limit') ?? '20';
      const params: Record<string, string> = { q: query, limit };
      if (kind) params.kind = kind;
      const qs = new URLSearchParams(params).toString();
      const res = await fetchDaemonJson<Record<string, unknown>>('GET', `/symbol?${qs}`, undefined, host, port);
      if (res) {
        return { exitCode: 0, output: formatOut('symbol', res), data: res };
      }
    } else if (command === 'refs' || command === 'references') {
      const target = primaryTarget;
      const limit = parseFlagValue(rawArgs, '--limit') ?? '40';
      const qs = new URLSearchParams({ q: target, limit }).toString();
      const res = await fetchDaemonJson<Record<string, unknown>>('GET', `/refs?${qs}`, undefined, host, port);
      if (res) {
        return { exitCode: 0, output: formatOut('refs', res), data: res };
      }
    } else if (command === 'outline') {
      const file = primaryTarget;
      const filter = parseFlagValue(rawArgs, '--filter') ?? '';
      const kind = parseFlagValue(rawArgs, '--kind') ?? '';
      const limit = parseFlagValue(rawArgs, '--limit') ?? '80';
      const exported = rawArgs.includes('--exported') || rawArgs.includes('--exported-only');
      const params: Record<string, string> = { file, limit };
      if (filter) params.filter = filter;
      if (kind) params.kind = kind;
      if (exported) params.exported = 'true';
      const qs = new URLSearchParams(params).toString();
      const res = await fetchDaemonJson<Record<string, unknown>>('GET', `/outline?${qs}`, undefined, host, port);
      if (res) {
        return { exitCode: 0, output: formatOut('outline', res), data: res };
      }
    } else if (command === 'search') {
      const query = primaryTarget;
      const kind = parseFlagValue(rawArgs, '--kind') ?? '';
      const limit = parseFlagValue(rawArgs, '--limit') ?? '25';
      const params: Record<string, string> = { q: query, limit };
      if (kind) params.kind = kind;
      const qs = new URLSearchParams(params).toString();
      const res = await fetchDaemonJson<Record<string, unknown>>('GET', `/search?${qs}`, undefined, host, port);
      if (res) {
        return { exitCode: 0, output: formatOut('search', res), data: res };
      }
    } else if (command === 'blast-radius') {
      const target = primaryTarget;
      const hops = parseFlagValue(rawArgs, '--depth') ?? parseFlagValue(rawArgs, '--hops') ?? '3';
      const qs = new URLSearchParams({ target, hops }).toString();
      const res = await fetchDaemonJson<Record<string, unknown>>(
        'GET',
        `/blast-radius?${qs}`,
        undefined,
        host,
        port,
      );
      if (res) {
        return { exitCode: 0, output: formatOut('blast-radius', res), data: res };
      }
    } else if (command === 'tests-for') {
      const target = primaryTarget;
      const qs = new URLSearchParams({ target }).toString();
      const res = await fetchDaemonJson<Record<string, unknown>>('GET', `/tests-for?${qs}`, undefined, host, port);
      if (res) {
        return { exitCode: 0, output: formatOut('tests-for', res), data: res };
      }
    } else if (command === 'lineage') {
      const target = primaryTarget;
      const qs = new URLSearchParams({ target }).toString();
      const res = await fetchDaemonJson<Record<string, unknown>>('GET', `/lineage?${qs}`, undefined, host, port);
      if (res) {
        return { exitCode: 0, output: formatOut('lineage', res), data: res };
      }
    } else if (command === 'path') {
      const from = positionals[1] ?? '';
      const to = positionals[2] ?? '';
      const hops = parseFlagValue(rawArgs, '--depth') ?? parseFlagValue(rawArgs, '--hops') ?? '6';
      const qs = new URLSearchParams({ from, to, hops }).toString();
      const res = await fetchDaemonJson<Record<string, unknown>>('GET', `/path?${qs}`, undefined, host, port);
      if (res) {
        return { exitCode: 0, output: formatOut('path', res), data: res };
      }
    }
  }

  // Fallback to direct SQLite WAL mode access
  const db = new AstGraphDatabase(dbPath);
  try {
    const indexer = new AstGraphIndexer(workspaceRoot, db);

    if (command === 'sync') {
      const force = rawArgs.includes('--force') || rawArgs.includes('--full');
      const syncResult = indexer.syncWorkspace({
        full: force || db.getCounts().files === 0,
        exportSnapshots: true,
      });
      const counts = db.getCounts();
      const data = { sync: syncResult, counts };
      return { exitCode: 0, output: JSON.stringify(data, null, 2), data };
    }

    // Ensure graph is initialized and lazily up to date before querying (scoped for single-file outline)
    const outlineHint = command === 'outline' && rawTargets.length === 1 ? primaryTarget : undefined;
    indexer.lazySyncIfDirty(outlineHint ? { targetFileHint: outlineHint } : undefined);

    switch (command) {
      case 'status': {
        const counts = db.getCounts();
        const data = { mode: 'sqlite-wal', dbPath: db.dbPath, counts };
        return { exitCode: 0, output: JSON.stringify(data, null, 2), data };
      }

      case 'symbol': {
        const targets = rawTargets.length > 0 ? rawTargets : [''];
        const kind = parseFlagValue(rawArgs, '--kind');
        const limit = Number(parseFlagValue(rawArgs, '--limit') ?? '20');
        if (targets.length > 1) {
          const batchItems = targets.map((t) => ({
            target: t,
            result: kind
              ? { query: t, kind, count: 0, matches: db.searchSymbols(t, kind, limit) }
              : db.getSymbolNeighborhood(t, { limit }),
          }));
          const data = { batchCount: batchItems.length, batchItems };
          return { exitCode: 0, output: formatOut('symbol', data), data };
        }
        const query = targets[0] ?? '';
        if (kind) {
          const matches = db.searchSymbols(query, kind, limit);
          const data = { query, kind, count: matches.length, matches };
          return { exitCode: 0, output: formatOut('symbol', data), data };
        }
        const neighborhood = db.getSymbolNeighborhood(query, { limit });
        return { exitCode: 0, output: formatOut('symbol', neighborhood), data: neighborhood };
      }

      case 'refs':
      case 'references': {
        const targets = rawTargets.length > 0 ? rawTargets : [''];
        const limit = Number(parseFlagValue(rawArgs, '--limit') ?? '40');
        if (targets.length > 1) {
          const batchItems = targets.map((t) => ({
            target: t,
            result: db.getSymbolReferences(t, { limit }),
          }));
          const data = { batchCount: batchItems.length, batchItems };
          return { exitCode: 0, output: formatOut('refs', data), data };
        }
        const data = db.getSymbolReferences(targets[0] ?? '', { limit });
        return { exitCode: 0, output: formatOut('refs', data), data };
      }

      case 'outline': {
        const targets = rawTargets.length > 0 ? rawTargets : [''];
        const filter = parseFlagValue(rawArgs, '--filter');
        const kind = parseFlagValue(rawArgs, '--kind');
        const exportedOnly = rawArgs.includes('--exported') || rawArgs.includes('--exported-only');
        const limit = Number(parseFlagValue(rawArgs, '--limit') ?? '80');
        if (targets.length > 1) {
          const batchItems = targets.map((fp) => ({
            target: fp,
            result: db.getFileOutline(fp, { filter, kind, exportedOnly, limit }),
          }));
          const data = { batchCount: batchItems.length, batchItems };
          return { exitCode: 0, output: formatOut('outline', data), data };
        }
        const data = db.getFileOutline(targets[0] ?? '', {
          filter,
          kind,
          exportedOnly,
          limit,
        });
        return { exitCode: 0, output: formatOut('outline', data), data };
      }

      case 'search': {
        const query = primaryTarget;
        const kind = parseFlagValue(rawArgs, '--kind');
        const limit = Number(parseFlagValue(rawArgs, '--limit') ?? '25');
        const matches = db.searchSymbols(query, kind, limit);
        const data = { query, kind, count: matches.length, matches };
        return { exitCode: 0, output: formatOut('search', data), data };
      }

      case 'callers': {
        const symbol = primaryTarget;
        const limit = Number(parseFlagValue(rawArgs, '--limit') ?? '20');
        const neighborhood = db.getSymbolNeighborhood(symbol, { limit });
        const data = {
          symbol,
          resolvedSymbol: neighborhood.symbol,
          count: neighborhood.callers.length,
          totalCallersCount: neighborhood.totalCallersCount,
          callers: neighborhood.callers,
        };
        return { exitCode: 0, output: formatOut('callers', data), data };
      }

      case 'callees': {
        const symbol = primaryTarget;
        const limit = Number(parseFlagValue(rawArgs, '--limit') ?? '20');
        const neighborhood = db.getSymbolNeighborhood(symbol, { limit });
        const data = {
          symbol,
          resolvedSymbol: neighborhood.symbol,
          count: neighborhood.callees.length,
          totalCalleesCount: neighborhood.totalCalleesCount,
          callees: neighborhood.callees,
        };
        return { exitCode: 0, output: formatOut('callees', data), data };
      }

      case 'blast-radius': {
        const symbol = primaryTarget;
        const depth = Number(parseFlagValue(rawArgs, '--depth') ?? parseFlagValue(rawArgs, '--hops') ?? '3');
        const data = db.getBlastRadius(symbol, depth);
        return { exitCode: 0, output: formatOut('blast-radius', data), data };
      }

      case 'tests-for': {
        const symbol = primaryTarget;
        const data = db.getTestsForChange(symbol);
        return { exitCode: 0, output: formatOut('tests-for', data), data };
      }

      case 'lineage': {
        const target = primaryTarget;
        const data = db.getCrossLayerLineage(target);
        return { exitCode: 0, output: formatOut('lineage', data), data };
      }

      case 'path': {
        const from = positionals[1] ?? '';
        const to = positionals[2] ?? '';
        const depth = Number(parseFlagValue(rawArgs, '--depth') ?? parseFlagValue(rawArgs, '--hops') ?? '6');
        const data = db.findShortestPath(from, to, depth);
        return { exitCode: 0, output: formatOut('path', data), data };
      }

      case 'analyze': {
        const data = analyzeGraph(db);
        return { exitCode: 0, output: JSON.stringify(data, null, 2), data };
      }

      case 'benchmark': {
        const data = runBenchmark(workspaceRoot, db, indexer);
        return { exitCode: 0, output: JSON.stringify(data, null, 2), data };
      }

      case 'export': {
        const format = (parseFlagValue(rawArgs, '--format') ?? positionals[1] ?? 'both').toLowerCase();
        const exportDir = path.dirname(db.dbPath);
        const exported = db.exportGraph(exportDir);
        if (format === 'cypher' || format === 'opencypher') {
          const cypherText = fs.readFileSync(exported.cypherPath, 'utf8');
          return { exitCode: 0, output: cypherText, data: exported };
        }
        if (format === 'jsonl') {
          const jsonlText = fs.readFileSync(exported.jsonlPath, 'utf8');
          return { exitCode: 0, output: jsonlText, data: exported };
        }
        return { exitCode: 0, output: JSON.stringify(exported, null, 2), data: exported };
      }

      default: {
        const helpData = {
          error: `Unknown command: ${command}`,
          commands: [
            'sync [--force]',
            'status',
            'symbol <query...> [--kind <kind>] [--limit <n>] [--raw-json]',
            'refs <propertyOrSymbol...> [--limit <n>] [--raw-json]',
            'outline <filePath...> [--filter <substr>] [--kind <kind>] [--exported] [--limit <n>] [--raw-json]',
            'search <query> [--kind <kind>] [--limit <n>] [--raw-json]',
            'callers <symbol> [--limit <n>] [--raw-json]',
            'callees <symbol> [--limit <n>] [--raw-json]',
            'blast-radius <symbol> [--depth <n>] [--raw-json]',
            'tests-for <symbol> [--raw-json]',
            'lineage <schemaOrRoute> [--raw-json]',
            'path <fromSymbol> <toSymbol> [--depth <n>] [--raw-json]',
            'analyze',
            'benchmark',
            'export [--format jsonl|cypher|both]',
          ],
        };
        return { exitCode: 1, output: JSON.stringify(helpData, null, 2), data: helpData };
      }
    }
  } finally {
    db.close();
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(0);
    }
  });
  executeCliCommand(process.argv.slice(2))
    .then(({ exitCode, output }) => {
      process.stdout.write(`${output}\n`);
      process.exitCode = exitCode;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      process.exitCode = 1;
    });
}
