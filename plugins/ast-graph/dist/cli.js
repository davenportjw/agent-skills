import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { assessWorkspace, canonicalizeWorkspaceRoot } from './assessor.js';
import { AstGraphDatabase } from './db.js';
import { AstGraphIndexer } from './indexer.js';
import { analyzeGraph, runBenchmark } from './analyzer.js';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4319;
async function fetchDaemonJson(method, endpointPath, body, host = DEFAULT_HOST, port = DEFAULT_PORT, connectTimeoutMs = 50, responseTimeoutMs = 2500) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (val) => {
            if (settled)
                return;
            settled = true;
            resolve(val);
        };
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
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
        }, (res) => {
            if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
                res.resume();
                finish(null);
                return;
            }
            const chunks = [];
            res.on('data', (chunk) => {
                chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            });
            res.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf8');
                    finish(JSON.parse(text));
                }
                catch {
                    finish(null);
                }
            });
        });
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
function parseFlagValue(args, flag) {
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
function oneLine(text, maxLen = 110) {
    if (!text)
        return '';
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen - 3)}...` : collapsed;
}
/**
 * Marker that separates the actionable summary block from detail lines. Formatters emit it
 * near the end; {@link moveSummaryFirst} hoists it directly under the header line so that
 * truncation only ever drops detail lines, never the summary.
 */
export const SUMMARY_MARKER = '=== TARGET SUMMARY ===';
/**
 * Inline byte budget for MCP/CLI text. Agent harnesses spill tool output above ~5 KB to a
 * file and show the model only the file path (observed in 35% of historical ast_* calls),
 * forcing an extra read round trip. Staying under this budget keeps results inline.
 */
export const INLINE_BYTE_BUDGET = 3800;
const DETAILS_MARKER = '--- details ---';
function byteLen(text) {
    return Buffer.byteLength(text, 'utf8');
}
/** Hoist the trailing summary block directly beneath the first (header) line. */
export function moveSummaryFirst(text) {
    const idx = text.lastIndexOf(SUMMARY_MARKER);
    if (idx === -1)
        return text;
    const summary = text.slice(idx).trimEnd();
    const head = text.slice(0, idx).trimEnd();
    const nl = head.indexOf('\n');
    const headerLine = nl === -1 ? head : head.slice(0, nl);
    const details = nl === -1 ? '' : head.slice(nl + 1).replace(/\n+$/, '');
    return details.trim()
        ? `${headerLine}\n${summary}\n${DETAILS_MARKER}\n${details}`
        : `${headerLine}\n${summary}`;
}
/**
 * Truncate whole lines from the bottom until the text fits `maxBytes`. Because summaries are
 * hoisted first, only detail lines are dropped. The footer tells the agent how to narrow the
 * query and where the full output lives (tee pattern, as popularized by rtk).
 */
export function enforceInlineSizeCap(text, maxBytes = INLINE_BYTE_BUDGET, options = {}) {
    if (byteLen(text) <= maxBytes)
        return text;
    const lines = text.split('\n');
    const footerFor = (omitted) => `  ... [${omitted} more lines omitted to stay inline <${(maxBytes / 1000).toFixed(1)}KB; narrow with filter/kind/limit${options.fullOutputPath ? ` | full output: ${options.fullOutputPath}` : ''}]`;
    const kept = [];
    let used = byteLen(footerFor(lines.length)) + 1;
    for (const line of lines) {
        const cost = byteLen(line) + 1;
        if (used + cost > maxBytes)
            break;
        kept.push(line);
        used += cost;
    }
    if (kept.length === 0) {
        // Single pathological line: hard-slice it.
        kept.push(Buffer.from(lines[0] ?? '').subarray(0, Math.max(0, maxBytes - 200)).toString('utf8'));
    }
    return `${kept.join('\n')}\n${footerFor(lines.length - kept.length)}`;
}
/** Persist the full formatted output to `<repo>/.ast-graph/last/<command>.txt`; best-effort. */
function teeFullOutput(workspaceRoot, command, text) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot)
        return undefined;
    try {
        const dir = path.join(workspaceRoot, '.ast-graph', 'last');
        if (!fs.existsSync(path.join(workspaceRoot, '.ast-graph')))
            return undefined;
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${command.replace(/[^a-z0-9_-]/gi, '_')}.txt`);
        fs.writeFileSync(file, text, 'utf8');
        return file;
    }
    catch {
        return undefined;
    }
}
/**
 * Render a compact, summary-first, byte-budgeted text view of an AST query payload for
 * agents (MCP `content[0].text` and CLI stdout).
 */
export function formatCompactCliOutput(command, data, queryArg = '', options = {}) {
    const maxBytes = options.maxBytes ?? INLINE_BYTE_BUDGET;
    const full = moveSummaryFirst(formatCompactBody(command, data, queryArg, maxBytes));
    if (byteLen(full) <= maxBytes)
        return full;
    const rec = (data ?? {});
    const fullOutputPath = options.tee === false ? undefined : teeFullOutput(rec.workspaceRoot, command, full);
    return enforceInlineSizeCap(full, maxBytes, { fullOutputPath });
}
function formatBatch(items, repoPrefix, maxBytes) {
    const header = `${repoPrefix}[AST BATCH] ${items.length} targets`;
    const perItem = Math.max(700, Math.floor((maxBytes - byteLen(header) - 40) / Math.max(1, items.length)));
    const parts = items.map((item, idx) => {
        const rendered = moveSummaryFirst(formatCompactBody(item.command, item.data, item.target, perItem));
        return enforceInlineSizeCap(`### [${idx + 1}/${items.length}] ${item.target}\n${rendered}`, perItem);
    });
    return [header, ...parts].join('\n\n');
}
function formatCompactBody(command, data, queryArg = '', maxBytes = INLINE_BYTE_BUDGET) {
    const rec = (data ?? {});
    const repoPrefix = typeof rec.workspaceRoot === 'string' && rec.workspaceRoot
        ? `[repo=${path.basename(rec.workspaceRoot)}] `
        : '';
    if (Array.isArray(rec.batchItems)) {
        const items = rec.batchItems;
        return formatBatch(items.map((item) => ({ command, target: item.target, data: item.result })), repoPrefix, maxBytes);
    }
    if (Array.isArray(rec.results)) {
        const items = rec.results;
        return formatBatch(items.map((item, idx) => ({
            command,
            target: String(item.query ?? item.target ?? `#${idx + 1}`),
            data: item,
        })), repoPrefix, maxBytes);
    }
    if (Array.isArray(rec.outlines)) {
        const items = rec.outlines;
        return formatBatch(items.map((item, idx) => ({
            command: 'outline',
            target: String(item.filePath ?? item.query ?? `#${idx + 1}`),
            data: item,
        })), repoPrefix, maxBytes);
    }
    if (command === 'refs' || command === 'references') {
        const targetLabel = String(rec.target ?? queryArg);
        const resolvedSymbols = rec.resolvedSymbols ?? [];
        const writes = rec.writes ?? [];
        const reads = rec.reads ?? [];
        const refs = rec.references ?? [];
        const totalWrites = Number(rec.totalWritesCount ?? writes.length);
        const totalReads = Number(rec.totalReadsCount ?? reads.length);
        const totalRefs = Number(rec.totalReferencesCount ?? refs.length);
        const lines = [
            `${repoPrefix}[AST REFERENCES] target="${targetLabel}" (writes=${totalWrites}, reads=${totalReads}, otherRefs=${totalRefs})`,
        ];
        if (resolvedSymbols.length > 0) {
            lines.push(`Declarations (${Math.min(resolvedSymbols.length, 10)} shown of ${resolvedSymbols.length}):`);
            for (const sym of resolvedSymbols.slice(0, 10)) {
                lines.push(`  - ${sym.qualifiedName ?? sym.name} (${sym.kind}) -> ${sym.filePath}#L${sym.startLine}-L${sym.endLine} | ${oneLine(String(sym.signature ?? sym.name), 90)}`);
            }
        }
        else {
            lines.push('Declarations: none found');
            const didYouMean = rec.didYouMean ?? [];
            if (didYouMean.length > 0) {
                lines.push(`Did you mean: ${didYouMean
                    .slice(0, 5)
                    .map((s) => `${s.name} (${s.kind} at ${s.filePath}#L${s.startLine}-L${s.endLine})`)
                    .join(', ')}`);
            }
        }
        lines.push(`WRITES_PROPERTY (${Math.min(writes.length, 25)} shown of ${totalWrites}):`);
        for (const w of writes.slice(0, 25)) {
            lines.push(`  - [WRITE] ${w.callSiteFile}#L${w.callSiteLine} inside ${w.srcName} (${w.srcKind}, L${w.srcStartLine}-L${w.srcEndLine})`);
        }
        lines.push(`READS_PROPERTY (${Math.min(reads.length, 25)} shown of ${totalReads}):`);
        for (const r of reads.slice(0, 25)) {
            lines.push(`  - [READ]  ${r.callSiteFile}#L${r.callSiteLine} inside ${r.srcName} (${r.srcKind}, L${r.srcStartLine}-L${r.srcEndLine})`);
        }
        if (refs.length > 0) {
            lines.push(`Other References (${Math.min(refs.length, 15)} shown of ${totalRefs}):`);
            for (const ref of refs.slice(0, 15)) {
                lines.push(`  - [${ref.edgeKind}] ${ref.callSiteFile}#L${ref.callSiteLine} inside ${ref.srcName} (${ref.srcKind}, L${ref.srcStartLine}-L${ref.srcEndLine})`);
            }
        }
        lines.push('');
        lines.push(SUMMARY_MARKER);
        lines.push(`Target Property/Symbol: ${targetLabel} (writes=${totalWrites}, reads=${totalReads})`);
        if (resolvedSymbols[0]) {
            const top = resolvedSymbols[0];
            lines.push(`Primary Declaration: ${top.qualifiedName ?? top.name} (${top.kind}) at ${top.filePath}#L${top.startLine}-L${top.endLine}`);
        }
        if (writes.length > 0) {
            lines.push(`Write Sites: ${writes
                .slice(0, 8)
                .map((w) => `${w.callSiteFile}#L${w.callSiteLine} (${w.srcName})`)
                .join(', ')}`);
        }
        if (reads.length > 0) {
            lines.push(`Read Sites: ${reads
                .slice(0, 8)
                .map((r) => `${r.callSiteFile}#L${r.callSiteLine} (${r.srcName})`)
                .join(', ')}`);
        }
        const primaryFocus = writes[0] ?? reads[0];
        if (primaryFocus) {
            lines.push(`Recommended Action: view_file on ${primaryFocus.callSiteFile} with StartLine=${primaryFocus.srcStartLine}, EndLine=${primaryFocus.srcEndLine}`);
        }
        return lines.join('\n');
    }
    if (command === 'symbol') {
        if ('symbol' in rec) {
            const sym = rec.symbol;
            const callers = rec.callers ?? [];
            const callees = rec.callees ?? [];
            const coveringTests = rec.coveringTests ?? [];
            const matches = rec.matches ?? [];
            const totalCallers = Number(rec.totalCallersCount ?? callers.length);
            const totalCallees = Number(rec.totalCalleesCount ?? callees.length);
            const totalTests = Number(rec.totalCoveringTestsCount ?? coveringTests.length);
            const queryLabel = String(rec.query ?? queryArg);
            if (!sym) {
                const lines = [
                    `${repoPrefix}[AST SYMBOL] No exact symbol match for "${queryLabel}". Showing ${Math.min(matches.length, 25)} closest suggestions:`,
                ];
                for (const m of matches.slice(0, 25)) {
                    lines.push(`  - ${m.name} (${m.kind}${m.exported ? ', exported' : ''}) -> ${m.filePath}#L${m.startLine}-L${m.endLine} | ${oneLine(String(m.signature ?? m.name), 90)}`);
                }
                const top = matches[0];
                lines.push('');
                lines.push(SUMMARY_MARKER);
                lines.push(`Query: "${queryLabel}" (No exact match; ${matches.length} symbol suggestions above)`);
                if (top) {
                    lines.push(`Top Suggestion: ${top.name} (${top.kind}) at ${top.filePath}#L${top.startLine}-L${top.endLine}`);
                    lines.push(`Recommended Action: view_file on ${top.filePath} with StartLine=${top.startLine}, EndLine=${top.endLine}`);
                }
                else {
                    lines.push('Recommended Action: Run `ast_outline` or `ast_search`');
                }
                return lines.join('\n');
            }
            const lines = [
                `${repoPrefix}[AST SYMBOL] ${sym.name} (${sym.kind}${sym.exported ? ', exported' : ''})`,
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
            lines.push(SUMMARY_MARKER);
            lines.push(`Target Symbol: ${sym.name} (${sym.kind})`);
            lines.push(`Exact Location: ${sym.filePath}#L${sym.startLine}-L${sym.endLine}`);
            lines.push(`Signature: ${oneLine(String(sym.signature ?? sym.name), 120)}`);
            lines.push(`Recommended Action: view_file on ${sym.filePath} with StartLine=${sym.startLine}, EndLine=${sym.endLine}`);
            return lines.join('\n');
        }
    }
    if (command === 'outline') {
        const filePath = rec.filePath ?? String(rec.query ?? queryArg);
        const symbols = rec.symbols ?? [];
        const candidateFiles = rec.candidateFiles ?? [];
        const totalSymbols = Number(rec.totalSymbolsInFile ?? rec.totalSymbols ?? symbols.length);
        const matchedCount = Number(rec.matchedSymbolsCount ?? symbols.length);
        const lines = [
            `${repoPrefix}[AST FILE OUTLINE] ${filePath} (${symbols.length} shown of ${matchedCount} matched / ${totalSymbols} total symbols in ${rec.lineCount ?? '?'} lines)`,
        ];
        // The file path is printed once in the header; detail lines carry only spans.
        for (const s of symbols) {
            lines.push(`  L${s.startLine}-L${s.endLine} [${s.kind}${s.exported ? ' exp' : ''}] ${s.name} :: ${oneLine(String(s.signature ?? s.name), 80)}`);
        }
        if (symbols.length === 0 && candidateFiles.length > 0) {
            lines.push(`  No exact file match for "${filePath}". Closest indexed files: ${candidateFiles.slice(0, 8).join(', ')}`);
        }
        else if (symbols.length === 0 && totalSymbols === 0) {
            lines.push(`  NOT INDEXED: "${filePath}" has no symbols in the graph. If the file exists, run ast_sync with paths=["${filePath}"] (or check the workspace), then retry.`);
        }
        else if (symbols.length === 0) {
            lines.push(`  ${totalSymbols} symbols exist in this file but none matched the filter/kind; broaden or omit them.`);
        }
        const first = symbols[0];
        lines.push('');
        lines.push(SUMMARY_MARKER);
        lines.push(`File Outline: ${filePath} (${matchedCount}/${totalSymbols} symbols matched)`);
        if (symbols.length > 0) {
            const keySpans = symbols
                .slice(0, 8)
                .map((s) => `${s.name} (${s.kind} #L${s.startLine}-L${s.endLine})`)
                .join(', ');
            lines.push(`Key Spans: ${keySpans}`);
        }
        if (first) {
            lines.push(`First Matched Symbol: ${first.name} (${first.kind}) at ${filePath}#L${first.startLine}-L${first.endLine}`);
            lines.push(`Recommended Action: view_file on ${filePath} with StartLine=${first.startLine}, EndLine=${first.endLine}`);
        }
        else {
            lines.push('Recommended Action: Try a broader --filter or omit --kind');
        }
        return lines.join('\n');
    }
    if (command === 'search' || (command === 'symbol' && 'matches' in rec && !('symbol' in rec))) {
        const matches = rec.matches ?? [];
        const q = String(rec.query ?? queryArg);
        const lines = [
            `${repoPrefix}[AST SEARCH] query="${q}"${rec.kind ? ` kind=${rec.kind}` : ''} (${matches.length} matches)`,
        ];
        // Group by file (first-appearance order preserves rank) so each path prints once.
        const byFile = new Map();
        for (const m of matches) {
            const key = String(m.filePath);
            if (!byFile.has(key))
                byFile.set(key, []);
            byFile.get(key).push(m);
        }
        for (const [file, group] of byFile) {
            lines.push(`  ${file}`);
            for (const m of group) {
                lines.push(`    L${m.startLine}-L${m.endLine} ${m.name} (${m.kind}${m.exported ? ', exp' : ''}) | ${oneLine(String(m.signature ?? m.name), 80)}`);
            }
        }
        const didYouMean = rec.didYouMean ?? [];
        const availableKinds = rec.availableKinds ?? [];
        const looksLikeLiteral = /\s|["'`<>{}()=;,]/.test(q.trim());
        if (matches.length === 0 && looksLikeLiteral) {
            lines.push(`  No symbol matches "${q}". It looks like a string literal / UI copy / log text, which is not indexed as a symbol: use grep -rn (or rg) for literals.`);
        }
        if (matches.length === 0 && rec.kind && availableKinds.length > 0) {
            lines.push(`  Kinds present in this repo: ${availableKinds
                .slice(0, 20)
                .map((k) => `${k.kind}(${k.count})`)
                .join(', ')}`);
        }
        if (matches.length === 0 && didYouMean.length > 0 && !looksLikeLiteral) {
            lines.push(`  Did you mean: ${didYouMean
                .slice(0, 6)
                .map((s) => `${s.name} (${s.kind} at ${s.filePath}#L${s.startLine}-L${s.endLine})`)
                .join(', ')}`);
        }
        const top = matches[0] ?? (looksLikeLiteral ? undefined : didYouMean[0]);
        lines.push('');
        lines.push(SUMMARY_MARKER);
        lines.push(`Search Query: "${q}" (${matches.length} matches${byFile.size > 1 ? ` across ${byFile.size} files` : ''})`);
        if (top) {
            lines.push(`Top Match: ${top.name} (${top.kind}) at ${top.filePath}#L${top.startLine}-L${top.endLine}`);
            lines.push(`Recommended Action: view_file on ${top.filePath} with StartLine=${top.startLine}, EndLine=${top.endLine}`);
        }
        else if (looksLikeLiteral) {
            lines.push(`Recommended Action: grep -rn ${JSON.stringify(q)} (literal text is not a symbol)`);
        }
        else {
            lines.push('Recommended Action: Try `ast_outline` on a target file');
        }
        return lines.join('\n');
    }
    if (command === 'blast-radius') {
        const resolvedSymbols = rec.resolvedSymbols ?? [];
        const impactedNodes = rec.impactedNodes ?? [];
        const impactedFiles = rec.impactedFiles ?? [];
        const impactedPackages = rec.impactedPackages ?? [];
        const recommendedTests = rec.recommendedTests ?? [];
        const didYouMean = rec.didYouMean ?? [];
        const vitestCmd = String(rec.vitestCommand ?? 'npm test');
        const focal = resolvedSymbols[0];
        const lines = [
            `${repoPrefix}[AST BLAST RADIUS] target="${String(rec.target ?? queryArg)}" (maxHops=${rec.maxHops ?? 3}, impactedNodes=${impactedNodes.length}, impactedFiles=${impactedFiles.length})`,
        ];
        if (focal) {
            lines.push(`Resolved Target: ${focal.name} (${focal.kind}) -> ${focal.filePath}#L${focal.startLine}-L${focal.endLine}`);
        }
        else if (didYouMean.length > 0) {
            lines.push(`Did you mean: ${didYouMean
                .slice(0, 5)
                .map((s) => `${s.name} (${s.kind} at ${s.filePath}#L${s.startLine}-L${s.endLine})`)
                .join(', ')}`);
        }
        lines.push(`Impacted Packages (${impactedPackages.length}): ${impactedPackages.join(', ') || 'none'}`);
        lines.push(`Impacted Symbols (${Math.min(impactedNodes.length, 30)} shown of ${impactedNodes.length}):`);
        for (const item of impactedNodes.slice(0, 30)) {
            lines.push(`  [hop ${item.hopDistance ?? 1} via ${item.viaEdgeKind}] ${item.name} (${item.kind}) -> ${item.filePath}#L${item.startLine}-L${item.endLine}`);
        }
        const testFiles = recommendedTests.map((t) => String(t.testFilePath));
        lines.push(`Covering Test Files (${testFiles.length}): ${testFiles.join(', ') || 'none'}`);
        lines.push('');
        lines.push(SUMMARY_MARKER);
        lines.push(`Blast Radius Target: ${String(rec.target ?? queryArg)} (${impactedNodes.length} impacted symbols across ${impactedFiles.length} files)`);
        if (focal) {
            lines.push(`Target Location: ${focal.filePath}#L${focal.startLine}-L${focal.endLine}`);
        }
        lines.push(`Impacted Packages: ${impactedPackages.join(', ') || 'none'}`);
        lines.push(`Recommended Test Command: ${vitestCmd}`);
        return lines.join('\n');
    }
    if (command === 'tests-for') {
        const resolvedSymbols = rec.resolvedSymbols ?? [];
        const testFiles = rec.testFiles ?? [];
        const directTests = rec.directTests ?? [];
        const transitiveTests = rec.transitiveTests ?? [];
        const vitestCmd = String(rec.vitestCommand ?? 'npm test');
        const lines = [
            `${repoPrefix}[AST TESTS FOR] target="${String(rec.target ?? queryArg)}" (${testFiles.length} test files, ${directTests.length} direct, ${transitiveTests.length} transitive)`,
            `Test Files: ${testFiles.join(', ') || 'none'}`,
        ];
        if (resolvedSymbols.length > 0) {
            lines.push(`Resolved Symbols (${Math.min(resolvedSymbols.length, 8)} shown): ${resolvedSymbols
                .slice(0, 8)
                .map((s) => `${s.name} (${s.kind} #L${s.startLine}-L${s.endLine})`)
                .join(', ')}`);
        }
        lines.push(`Direct Tests (${Math.min(directTests.length, 20)} shown of ${directTests.length}):`);
        for (const t of directTests.slice(0, 20)) {
            lines.push(`  - [${t.kind}] ${t.name} -> ${t.filePath}#L${t.startLine}-L${t.endLine}`);
        }
        if (transitiveTests.length > 0) {
            lines.push(`Transitive Tests (${Math.min(transitiveTests.length, 8)} shown of ${transitiveTests.length}):`);
            for (const t of transitiveTests.slice(0, 8)) {
                lines.push(`  - [${t.kind}] ${t.name} -> ${t.filePath}#L${t.startLine}-L${t.endLine}`);
            }
        }
        lines.push('');
        lines.push(SUMMARY_MARKER);
        lines.push(`Target: ${String(rec.target ?? queryArg)} (${testFiles.length} covering test files)`);
        lines.push(`Test Files: ${testFiles.join(', ') || 'none'}`);
        lines.push(`Recommended Test Command: ${vitestCmd}`);
        return lines.join('\n');
    }
    if (command === 'callers' || command === 'callees') {
        const sym = rec.resolvedSymbol;
        const list = rec[command] ?? [];
        const total = Number((command === 'callers' ? rec.totalCallersCount : rec.totalCalleesCount) ?? list.length);
        const lines = [
            `${repoPrefix}[AST ${command.toUpperCase()}] symbol="${String(rec.symbol ?? queryArg)}" (${Math.min(list.length, 35)} shown of ${total})`,
        ];
        for (const item of list.slice(0, 35)) {
            const name = command === 'callers' ? item.srcName : item.dstName;
            const kind = command === 'callers' ? item.srcKind : item.dstKind;
            const file = command === 'callers' ? item.srcFilePath : item.dstFilePath;
            const line = command === 'callers' ? item.srcLine : item.dstLine;
            lines.push(`  - ${name} (${kind}) -> ${file}#L${line} (callSite L${item.callSiteLine ?? line})`);
        }
        lines.push('');
        lines.push(SUMMARY_MARKER);
        if (sym) {
            lines.push(`Target Symbol: ${sym.name} (${sym.kind}) at ${sym.filePath}#L${sym.startLine}-L${sym.endLine}`);
        }
        else {
            lines.push(`Target Symbol: ${String(rec.symbol ?? queryArg)} (unresolved)`);
        }
        lines.push(`Total ${command}: ${total}`);
        return lines.join('\n');
    }
    if (command === 'lineage') {
        const focalNodes = rec.focalNodes ?? [];
        const validators = rec.validators ?? [];
        const emitters = rec.emitters ?? [];
        const routesHandled = rec.routesHandled ?? [];
        const endpointClients = rec.endpointClients ?? [];
        const infraProvisions = rec.infraProvisions ?? [];
        const downstreamConsumers = rec.downstreamConsumers ?? [];
        const focal = focalNodes[0];
        const lines = [`${repoPrefix}[AST LINEAGE] target="${String(rec.target ?? queryArg)}"`];
        if (focal) {
            lines.push(`Focal Symbol: ${focal.name} (${focal.kind}) -> ${focal.filePath}#L${focal.startLine}-L${focal.endLine}`);
        }
        const addEdges = (label, items) => {
            if (items.length === 0)
                return;
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
        lines.push(SUMMARY_MARKER);
        lines.push(`Lineage Target: ${String(rec.target ?? queryArg)} (validators=${validators.length}, routes=${routesHandled.length}, clients=${endpointClients.length}, infra=${infraProvisions.length}, consumers=${downstreamConsumers.length})`);
        if (focal) {
            lines.push(`Root Location: ${focal.filePath}#L${focal.startLine}-L${focal.endLine}`);
        }
        return lines.join('\n');
    }
    if (command === 'path') {
        const steps = rec.path ?? [];
        const lines = [
            `${repoPrefix}[AST SHORTEST PATH] from="${String(rec.fromTarget ?? '')}" to="${String(rec.toTarget ?? '')}" (found=${Boolean(rec.found)}, hops=${rec.hopCount ?? steps.length})`,
        ];
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            lines.push(`  ${i + 1}. ${s.fromName} (${s.fromFile}) --[${s.edgeKind}]--> ${s.toName} (${s.toFile}#L${s.line})`);
        }
        lines.push('');
        lines.push(SUMMARY_MARKER);
        lines.push(`Shortest Path: ${String(rec.fromTarget ?? '')} -> ${String(rec.toTarget ?? '')} (found=${Boolean(rec.found)}, hops=${rec.hopCount ?? steps.length})`);
        return lines.join('\n');
    }
    return JSON.stringify(data, null, 2);
}
function getPositionalArgs(args) {
    const positionals = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            if ((arg === '--depth' ||
                arg === '--hops' ||
                arg === '--kind' ||
                arg === '--limit' ||
                arg === '--filter' ||
                arg === '--format' ||
                arg === '--db' ||
                arg === '--workspace') &&
                i + 1 < args.length) {
                i++;
            }
            continue;
        }
        positionals.push(arg);
    }
    return positionals;
}
export async function executeCliCommand(rawArgs, options) {
    const positionals = getPositionalArgs(rawArgs);
    const command = (positionals[0] ?? 'status').toLowerCase();
    const rawTargets = positionals
        .slice(1)
        .flatMap((t) => (command === 'path' ? [t] : t.split(',')))
        .map((t) => t.trim())
        .filter(Boolean);
    const primaryTarget = rawTargets[0] ?? '';
    const rawJson = rawArgs.includes('--raw-json') || rawArgs.includes('--json');
    const workspaceFlag = parseFlagValue(rawArgs, '--workspace');
    const rawWorkspace = options?.workspaceRoot ??
        workspaceFlag ??
        (command === 'assess' && primaryTarget ? primaryTarget : process.cwd());
    const workspaceRoot = canonicalizeWorkspaceRoot(rawWorkspace);
    const dbFlag = parseFlagValue(rawArgs, '--db');
    const dbPath = options?.dbPath ??
        (dbFlag ? path.resolve(workspaceRoot, dbFlag) : path.join(workspaceRoot, '.ast-graph', 'ast.db'));
    const useDaemon = options?.useDaemon === true && !dbFlag && !workspaceFlag;
    const host = options?.daemonHost ?? DEFAULT_HOST;
    const port = options?.daemonPort ?? DEFAULT_PORT;
    const formatOut = (cmd, payload) => {
        if (rawJson)
            return JSON.stringify(payload, null, 2);
        // Ensure workspaceRoot is present so the formatter can tag the repo and tee full output.
        const withRoot = payload && typeof payload === 'object' && !Array.isArray(payload) && !('workspaceRoot' in payload)
            ? { workspaceRoot, ...payload }
            : payload;
        return formatCompactCliOutput(cmd, withRoot, primaryTarget);
    };
    if (command === 'assess') {
        const manifest = assessWorkspace(workspaceRoot);
        return {
            exitCode: 0,
            output: JSON.stringify(manifest, null, 2),
            data: manifest,
        };
    }
    // Try daemon first if allowed and command is supported over HTTP (for single-target queries)
    if (useDaemon && rawTargets.length <= 1) {
        if (command === 'status') {
            const daemonHealth = await fetchDaemonJson('GET', '/health', undefined, host, port);
            if (daemonHealth) {
                const output = JSON.stringify({ mode: 'daemon', ...daemonHealth }, null, 2);
                return { exitCode: 0, output, data: daemonHealth };
            }
        }
        else if (command === 'symbol') {
            const query = primaryTarget;
            const kind = parseFlagValue(rawArgs, '--kind') ?? '';
            const limit = parseFlagValue(rawArgs, '--limit') ?? '20';
            const params = { q: query, limit };
            if (kind)
                params.kind = kind;
            const qs = new URLSearchParams(params).toString();
            const res = await fetchDaemonJson('GET', `/symbol?${qs}`, undefined, host, port);
            if (res) {
                return { exitCode: 0, output: formatOut('symbol', res), data: res };
            }
        }
        else if (command === 'refs' || command === 'references') {
            const target = primaryTarget;
            const limit = parseFlagValue(rawArgs, '--limit') ?? '25';
            const qs = new URLSearchParams({ q: target, limit }).toString();
            const res = await fetchDaemonJson('GET', `/refs?${qs}`, undefined, host, port);
            if (res) {
                return { exitCode: 0, output: formatOut('refs', res), data: res };
            }
        }
        else if (command === 'outline') {
            const file = primaryTarget;
            const filter = parseFlagValue(rawArgs, '--filter') ?? '';
            const kind = parseFlagValue(rawArgs, '--kind') ?? '';
            const limit = parseFlagValue(rawArgs, '--limit') ?? '40';
            const exported = rawArgs.includes('--exported') || rawArgs.includes('--exported-only');
            const params = { file, limit };
            if (filter)
                params.filter = filter;
            if (kind)
                params.kind = kind;
            if (exported)
                params.exported = 'true';
            const qs = new URLSearchParams(params).toString();
            const res = await fetchDaemonJson('GET', `/outline?${qs}`, undefined, host, port);
            if (res) {
                return { exitCode: 0, output: formatOut('outline', res), data: res };
            }
        }
        else if (command === 'search') {
            const query = primaryTarget;
            const kind = parseFlagValue(rawArgs, '--kind') ?? '';
            const limit = parseFlagValue(rawArgs, '--limit') ?? '15';
            const params = { q: query, limit };
            if (kind)
                params.kind = kind;
            const qs = new URLSearchParams(params).toString();
            const res = await fetchDaemonJson('GET', `/search?${qs}`, undefined, host, port);
            if (res) {
                return { exitCode: 0, output: formatOut('search', res), data: res };
            }
        }
        else if (command === 'blast-radius') {
            const target = primaryTarget;
            const hops = parseFlagValue(rawArgs, '--depth') ?? parseFlagValue(rawArgs, '--hops') ?? '3';
            const qs = new URLSearchParams({ target, hops }).toString();
            const res = await fetchDaemonJson('GET', `/blast-radius?${qs}`, undefined, host, port);
            if (res) {
                return { exitCode: 0, output: formatOut('blast-radius', res), data: res };
            }
        }
        else if (command === 'tests-for') {
            const target = primaryTarget;
            const qs = new URLSearchParams({ target }).toString();
            const res = await fetchDaemonJson('GET', `/tests-for?${qs}`, undefined, host, port);
            if (res) {
                return { exitCode: 0, output: formatOut('tests-for', res), data: res };
            }
        }
        else if (command === 'lineage') {
            const target = primaryTarget;
            const qs = new URLSearchParams({ target }).toString();
            const res = await fetchDaemonJson('GET', `/lineage?${qs}`, undefined, host, port);
            if (res) {
                return { exitCode: 0, output: formatOut('lineage', res), data: res };
            }
        }
        else if (command === 'path') {
            const from = positionals[1] ?? '';
            const to = positionals[2] ?? '';
            const hops = parseFlagValue(rawArgs, '--depth') ?? parseFlagValue(rawArgs, '--hops') ?? '6';
            const qs = new URLSearchParams({ from, to, hops }).toString();
            const res = await fetchDaemonJson('GET', `/path?${qs}`, undefined, host, port);
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
                const limit = Number(parseFlagValue(rawArgs, '--limit') ?? '25');
                const queryOne = (t) => {
                    const res = db.getSymbolReferences(t, { limit });
                    return res.resolvedSymbols.length === 0 &&
                        res.totalWritesCount === 0 &&
                        res.totalReadsCount === 0 &&
                        res.totalReferencesCount === 0
                        ? { ...res, didYouMean: db.suggestClosestSymbols(t, 6) }
                        : res;
                };
                if (targets.length > 1) {
                    const batchItems = targets.map((t) => ({
                        target: t,
                        result: queryOne(t),
                    }));
                    const data = { batchCount: batchItems.length, batchItems };
                    return { exitCode: 0, output: formatOut('refs', data), data };
                }
                const data = queryOne(targets[0] ?? '');
                return { exitCode: 0, output: formatOut('refs', data), data };
            }
            case 'outline': {
                const targets = rawTargets.length > 0 ? rawTargets : [''];
                const filter = parseFlagValue(rawArgs, '--filter');
                const kind = parseFlagValue(rawArgs, '--kind');
                const exportedOnly = rawArgs.includes('--exported') || rawArgs.includes('--exported-only');
                const limit = Number(parseFlagValue(rawArgs, '--limit') ?? '40');
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
                const limit = Number(parseFlagValue(rawArgs, '--limit') ?? '15');
                const matches = db.searchSymbols(query, kind, limit);
                const data = matches.length === 0
                    ? {
                        workspaceRoot,
                        query,
                        kind,
                        count: 0,
                        matches,
                        didYouMean: db.suggestClosestSymbols(query, 6),
                        ...(kind ? { availableKinds: db.listKindCounts() } : {}),
                    }
                    : { workspaceRoot, query, kind, count: matches.length, matches };
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
    }
    finally {
        db.close();
    }
}
const isMain = (() => {
    if (!process.argv[1])
        return false;
    if (process.argv[1].endsWith('/cli.js') || process.argv[1].endsWith('/cli.ts'))
        return true;
    try {
        return (fs.realpathSync(path.resolve(process.argv[1])) ===
            fs.realpathSync(fileURLToPath(import.meta.url)));
    }
    catch {
        return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
    }
})();
if (isMain) {
    process.stdout.on('error', (err) => {
        if (err.code === 'EPIPE') {
            process.exit(0);
        }
    });
    executeCliCommand(process.argv.slice(2))
        .then(({ exitCode, output }) => {
        process.stdout.write(`${output}\n`);
        process.exitCode = exitCode;
    })
        .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${JSON.stringify({ error: message })}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli.js.map