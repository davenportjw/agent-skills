import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { assessWorkspace, canonicalizeWorkspaceRoot, findEnclosingRepoRoot } from './assessor.js';
import { AstGraphDatabase } from './db.js';
import { AstGraphIndexer } from './indexer.js';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4319;
/**
 * Polymorphically parses stdin JSON from either Antigravity or Claude Code hook harnesses.
 */
export function parseHookInput(eventTypeArg, rawStdinJson) {
    const trimmed = rawStdinJson.trim();
    let parsed = {};
    if (trimmed.length > 0) {
        try {
            const candidate = JSON.parse(trimmed);
            if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                parsed = candidate;
            }
        }
        catch {
            parsed = {};
        }
    }
    // Detect Antigravity format: { toolCall: { name, args: { Path, TargetFile, AbsolutePath, ... } }, workspacePaths: [...] }
    const toolCall = parsed.toolCall;
    const toolCallArgs = toolCall?.args ?? undefined;
    const agyTargetFile = (typeof toolCallArgs?.Path === 'string' ? toolCallArgs.Path : undefined) ??
        (typeof toolCallArgs?.TargetFile === 'string' ? toolCallArgs.TargetFile : undefined) ??
        (typeof toolCallArgs?.AbsolutePath === 'string' ? toolCallArgs.AbsolutePath : undefined) ??
        (typeof parsed.Path === 'string' ? parsed.Path : undefined) ??
        (typeof parsed.TargetFile === 'string' ? parsed.TargetFile : undefined);
    // Detect Claude Code format: { hook_event_name, tool_name, tool_input: { file_path, path }, cwd }
    const toolInput = parsed.tool_input;
    const claudeFilePath = (typeof toolInput?.file_path === 'string' ? toolInput.file_path : undefined) ??
        (typeof toolInput?.path === 'string' ? toolInput.path : undefined) ??
        (typeof parsed.file_path === 'string' ? parsed.file_path : undefined);
    const workspacePaths = [];
    if (Array.isArray(parsed.workspacePaths)) {
        for (const wp of parsed.workspacePaths) {
            if (typeof wp === 'string' && wp.trim()) {
                workspacePaths.push(wp.trim());
            }
        }
    }
    if (typeof parsed.cwd === 'string' && parsed.cwd.trim()) {
        workspacePaths.push(parsed.cwd.trim());
    }
    let harness = 'unknown';
    if (toolCall !== undefined ||
        typeof parsed.conversationId === 'string' ||
        typeof parsed.TargetFile === 'string' ||
        typeof parsed.Path === 'string' ||
        Array.isArray(parsed.workspacePaths)) {
        harness = 'antigravity';
    }
    else if (toolInput !== undefined ||
        typeof parsed.hook_event_name === 'string' ||
        typeof parsed.tool_name === 'string' ||
        typeof parsed.session_id === 'string') {
        harness = 'claude-code';
    }
    const normalizedEvent = eventTypeArg ||
        (typeof parsed.hook_event_name === 'string' ? parsed.hook_event_name : '') ||
        (typeof parsed.event === 'string' ? parsed.event : '') ||
        'post-tool-use';
    return {
        harness,
        eventType: normalizedEvent,
        filePath: agyTargetFile ?? claudeFilePath,
        workspacePaths,
        rawPayload: parsed,
    };
}
async function tryPingDaemonSync(endpoint, body, host, port, timeoutMs = 75) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            hostname: host,
            port,
            path: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: timeoutMs,
        }, (res) => {
            res.resume();
            res.on('end', () => {
                resolve((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300);
            });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.on('error', () => {
            resolve(false);
        });
        req.write(payload);
        req.end();
    });
}
/**
 * Executes a hook invocation for either `session-start` or `post-tool-use` and returns
 * the harness-compatible stdout JSON response alongside timing telemetry.
 */
export async function handleHookInvocation(eventTypeArg, rawStdinJson, options) {
    const startTime = performance.now();
    const parsed = parseHookInput(eventTypeArg, rawStdinJson);
    const fallbackRoot = canonicalizeWorkspaceRoot(options?.workspaceRoot ?? process.cwd());
    const lowerEvent = parsed.eventType.toLowerCase();
    let filesUpdated = 0;
    const resolvedWorkspaces = [];
    if (lowerEvent === 'session-start' || lowerEvent === 'sessionstart') {
        const rawRoots = options?.workspaceRoot
            ? [options.workspaceRoot]
            : parsed.workspacePaths.length > 0
                ? parsed.workspacePaths
                : [fallbackRoot];
        const uniqueRoots = [
            ...new Set(rawRoots.map((r) => options?.workspaceRoot
                ? canonicalizeWorkspaceRoot(r)
                : findEnclosingRepoRoot(r) ?? canonicalizeWorkspaceRoot(r))),
        ];
        for (const wsRoot of uniqueRoots) {
            resolvedWorkspaces.push(wsRoot);
            const dbPath = options?.dbPath ?? path.join(wsRoot, '.ast-graph', 'ast.db');
            const daemonHandled = options?.useDaemon === true
                ? await tryPingDaemonSync('/sync', { full: false }, options?.daemonHost ?? DEFAULT_HOST, options?.daemonPort ?? DEFAULT_PORT)
                : false;
            if (!daemonHandled) {
                assessWorkspace(wsRoot);
                const db = new AstGraphDatabase(dbPath);
                try {
                    const indexer = new AstGraphIndexer(wsRoot, db);
                    const result = indexer.lazySyncIfDirty();
                    filesUpdated += result.filesUpdated;
                }
                finally {
                    db.close();
                }
            }
        }
    }
    else {
        // post-tool-use / PostToolUse
        if (parsed.filePath) {
            const absTarget = path.isAbsolute(parsed.filePath)
                ? parsed.filePath
                : path.resolve(parsed.workspacePaths[0] ?? fallbackRoot, parsed.filePath);
            const wsRoot = options?.workspaceRoot
                ? canonicalizeWorkspaceRoot(options.workspaceRoot)
                : findEnclosingRepoRoot(absTarget) ?? fallbackRoot;
            resolvedWorkspaces.push(wsRoot);
            const dbPath = options?.dbPath ?? path.join(wsRoot, '.ast-graph', 'ast.db');
            const daemonHandled = options?.useDaemon === true
                ? await tryPingDaemonSync('/sync', { full: false, paths: [parsed.filePath] }, options?.daemonHost ?? DEFAULT_HOST, options?.daemonPort ?? DEFAULT_PORT)
                : false;
            if (daemonHandled) {
                filesUpdated = 1;
            }
            else {
                assessWorkspace(wsRoot);
                const db = new AstGraphDatabase(dbPath);
                try {
                    const indexer = new AstGraphIndexer(wsRoot, db);
                    const counts = db.getCounts();
                    if (counts.files === 0) {
                        indexer.syncWorkspace({ full: true });
                    }
                    const delta = indexer.syncWorkspace({
                        full: false,
                        targetPaths: [absTarget],
                    });
                    filesUpdated = delta.filesUpdated + delta.filesDeleted;
                }
                finally {
                    db.close();
                }
            }
        }
        else {
            const wsRoot = options?.workspaceRoot
                ? canonicalizeWorkspaceRoot(options.workspaceRoot)
                : findEnclosingRepoRoot(parsed.workspacePaths[0] ?? fallbackRoot) ?? fallbackRoot;
            resolvedWorkspaces.push(wsRoot);
            const dbPath = options?.dbPath ?? path.join(wsRoot, '.ast-graph', 'ast.db');
            assessWorkspace(wsRoot);
            const db = new AstGraphDatabase(dbPath);
            try {
                const indexer = new AstGraphIndexer(wsRoot, db);
                const delta = indexer.lazySyncIfDirty();
                filesUpdated = delta.filesUpdated + delta.filesDeleted;
            }
            finally {
                db.close();
            }
        }
    }
    const durationMs = Number((performance.now() - startTime).toFixed(2));
    let stdoutJson;
    if (parsed.harness === 'claude-code') {
        stdoutJson = { continue: true };
    }
    else {
        stdoutJson = {};
    }
    return {
        harness: parsed.harness,
        eventType: parsed.eventType,
        filePath: parsed.filePath,
        workspaceRoots: resolvedWorkspaces,
        filesUpdated,
        durationMs,
        stdoutJson,
    };
}
async function readStdin(timeoutMs = 250) {
    if (process.stdin.isTTY) {
        return '';
    }
    return new Promise((resolve) => {
        const chunks = [];
        const timer = setTimeout(() => {
            process.stdin.removeAllListeners();
            resolve(Buffer.concat(chunks).toString('utf8'));
        }, timeoutMs);
        process.stdin.on('data', (chunk) => {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        process.stdin.on('end', () => {
            clearTimeout(timer);
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        process.stdin.on('error', () => {
            clearTimeout(timer);
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
    });
}
const isMain = (() => {
    if (!process.argv[1])
        return false;
    if (process.argv[1].endsWith('/hook-handler.js') ||
        process.argv[1].endsWith('/hook-handler.ts')) {
        return true;
    }
    try {
        return (fs.realpathSync(path.resolve(process.argv[1])) ===
            fs.realpathSync(fileURLToPath(import.meta.url)));
    }
    catch {
        return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
    }
})();
if (isMain) {
    const eventArg = process.argv[2] ?? 'post-tool-use';
    readStdin()
        .then((rawStdin) => handleHookInvocation(eventArg, rawStdin))
        .then((result) => {
        process.stdout.write(`${JSON.stringify(result.stdoutJson)}\n`);
    })
        .catch(() => {
        process.stdout.write('{}\n');
    });
}
//# sourceMappingURL=hook-handler.js.map