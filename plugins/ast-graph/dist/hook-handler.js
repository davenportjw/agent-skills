import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { assessWorkspace, canonicalizeWorkspaceRoot, findEnclosingRepoRoot, pruneGlobalRegistry, unregisterWorkspaceFromGlobalRegistry, } from './assessor.js';
import { AstGraphDatabase } from './db.js';
import { AstGraphIndexer } from './indexer.js';
import { activeLockOwner, syncLockPath } from './sync-lock.js';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4319;
function tokenizeShellSegment(segment) {
    const tokens = [];
    const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(segment)) !== null) {
        tokens.push((m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(["\\$`])/g, '$1'));
    }
    return tokens;
}
/**
 * Parses shell command strings (`run_command` / `Bash`) for Git repository, worktree, and branch
 * lifecycle operations (`worktree add/remove/prune`, `switch/checkout/pull/merge/rebase/reset`, `init/clone`).
 */
export function extractGitLifecycleActions(commandLine, defaultCwd) {
    if (!commandLine || !/\bgit\b/.test(commandLine))
        return [];
    const actions = [];
    let activeCwd = path.resolve(defaultCwd);
    const segments = commandLine.split(/\s*(?:&&|\|\||;|\r?\n)\s*/);
    for (const rawSeg of segments) {
        const seg = rawSeg.trim();
        if (!seg)
            continue;
        const tokens = tokenizeShellSegment(seg);
        if (tokens.length === 0)
            continue;
        // Strip leading VAR=val assignments
        let idx = 0;
        while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
            idx += 1;
        }
        const cmd = tokens[idx];
        if (!cmd)
            continue;
        if (cmd === 'cd' && tokens[idx + 1]) {
            activeCwd = path.resolve(activeCwd, tokens[idx + 1]);
            continue;
        }
        if (cmd !== 'git')
            continue;
        let gitCwd = activeCwd;
        let gIdx = idx + 1;
        while (gIdx < tokens.length) {
            const tok = tokens[gIdx];
            if (tok === '-C' && tokens[gIdx + 1]) {
                gitCwd = path.resolve(gitCwd, tokens[gIdx + 1]);
                gIdx += 2;
            }
            else if (tok === '-c' && tokens[gIdx + 1]) {
                gIdx += 2;
            }
            else if (tok.startsWith('--git-dir=') || tok.startsWith('--work-tree=') || tok === '--no-pager') {
                gIdx += 1;
            }
            else {
                break;
            }
        }
        const sub = tokens[gIdx];
        if (!sub)
            continue;
        if (sub === 'worktree') {
            const wtSub = tokens[gIdx + 1];
            if (wtSub === 'add') {
                const valueFlags = new Set(['-b', '-B', '--reason']);
                let aIdx = gIdx + 2;
                let wtPath = null;
                while (aIdx < tokens.length) {
                    const t = tokens[aIdx];
                    if (valueFlags.has(t)) {
                        aIdx += 2;
                        continue;
                    }
                    if (t.startsWith('-')) {
                        aIdx += 1;
                        continue;
                    }
                    wtPath = path.resolve(gitCwd, t);
                    break;
                }
                if (wtPath) {
                    actions.push({ kind: 'worktree-add', targetPath: wtPath });
                }
            }
            else if (wtSub === 'remove') {
                const targets = [];
                for (let rIdx = gIdx + 2; rIdx < tokens.length; rIdx += 1) {
                    const t = tokens[rIdx];
                    if (t.startsWith('-'))
                        continue;
                    targets.push(path.resolve(gitCwd, t));
                }
                if (targets.length > 0) {
                    actions.push({ kind: 'worktree-remove', targetPaths: targets });
                }
            }
            else if (wtSub === 'prune') {
                actions.push({ kind: 'worktree-prune' });
            }
            continue;
        }
        if (sub === 'checkout' ||
            sub === 'switch' ||
            sub === 'pull' ||
            sub === 'merge' ||
            sub === 'rebase' ||
            sub === 'reset' ||
            sub === 'cherry-pick' ||
            sub === 'revert') {
            actions.push({ kind: 'head-mutation', repoPath: gitCwd });
            continue;
        }
        if (sub === 'init') {
            let targetDir = gitCwd;
            for (let iIdx = gIdx + 1; iIdx < tokens.length; iIdx += 1) {
                const t = tokens[iIdx];
                if (t === '-b' || t === '--initial-branch' || t === '--template' || t === '--separate-git-dir') {
                    iIdx += 1;
                    continue;
                }
                if (t.startsWith('-'))
                    continue;
                targetDir = path.resolve(gitCwd, t);
                break;
            }
            actions.push({ kind: 'repo-created', targetPath: targetDir });
            continue;
        }
        if (sub === 'clone') {
            const valueFlags = new Set(['-b', '--branch', '-o', '--origin', '--depth', '--reference', '--filter', '-j', '--jobs', '-c', '--config']);
            const positionals = [];
            for (let cIdx = gIdx + 1; cIdx < tokens.length; cIdx += 1) {
                const t = tokens[cIdx];
                if (valueFlags.has(t)) {
                    cIdx += 1;
                    continue;
                }
                if (t.startsWith('-'))
                    continue;
                positionals.push(t);
            }
            if (positionals.length >= 2) {
                actions.push({ kind: 'repo-created', targetPath: path.resolve(gitCwd, positionals[1]) });
            }
            else if (positionals.length === 1) {
                const base = path.basename(positionals[0].replace(/\/+$/, '').replace(/\.git$/, ''));
                if (base) {
                    actions.push({ kind: 'repo-created', targetPath: path.resolve(gitCwd, base) });
                }
            }
        }
    }
    return actions;
}
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
    const agyToolName = typeof toolCall?.name === 'string' ? toolCall.name : undefined;
    const agyCommandLine = typeof toolCallArgs?.CommandLine === 'string'
        ? toolCallArgs.CommandLine
        : typeof toolCallArgs?.command === 'string'
            ? toolCallArgs.command
            : undefined;
    // Detect Claude Code format: { hook_event_name, tool_name, tool_input: { file_path, path, command }, cwd }
    const toolInput = parsed.tool_input;
    const claudeToolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : undefined;
    const claudeFilePath = (typeof toolInput?.file_path === 'string' ? toolInput.file_path : undefined) ??
        (typeof toolInput?.path === 'string' ? toolInput.path : undefined) ??
        (typeof parsed.file_path === 'string' ? parsed.file_path : undefined);
    const claudeCommandLine = typeof toolInput?.command === 'string' ? toolInput.command : undefined;
    const workspacePaths = [];
    if (typeof parsed.cwd === 'string' && parsed.cwd.trim()) {
        workspacePaths.push(parsed.cwd.trim());
    }
    if (Array.isArray(parsed.workspacePaths)) {
        for (const wp of parsed.workspacePaths) {
            if (typeof wp === 'string' && wp.trim() && !workspacePaths.includes(wp.trim())) {
                workspacePaths.push(wp.trim());
            }
        }
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
    const toolResponse = parsed.tool_response;
    const commandFailed = Boolean(parsed.error) ||
        (typeof toolResponse?.exitCode === 'number' && toolResponse.exitCode !== 0);
    return {
        harness,
        eventType: normalizedEvent,
        toolName: agyToolName ?? claudeToolName,
        filePath: agyTargetFile ?? claudeFilePath,
        commandLine: agyCommandLine ?? claudeCommandLine,
        commandFailed,
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
function resolveCliEntrypoint() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of [path.join(here, 'cli.js'), path.join(here, '..', 'dist', 'cli.js')]) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    return null;
}
/** Start a detached cold build unless another process already owns the repo's sync lock. */
function spawnBackgroundBuild(wsRoot, dbPath) {
    if (activeLockOwner(syncLockPath(dbPath)))
        return true; // someone is already building it
    const cli = resolveCliEntrypoint();
    if (!cli)
        return false;
    try {
        const child = spawn(process.execPath, ['--no-warnings', cli, 'sync', '--no-export', '--workspace', wsRoot, '--db', dbPath], { cwd: wsRoot, detached: true, stdio: 'ignore' });
        child.unref();
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Run one repo sync from a hook. Hooks must never fail or stall the harness: a cold index is built
 * in the background (when requested), and lock contention / INDEX_BUILDING are treated as no-ops
 * because the lock owner is already bringing the index up to date.
 */
function runHookSync(wsRoot, dbPath, coldBuild, work) {
    assessWorkspace(wsRoot);
    const db = new AstGraphDatabase(dbPath);
    try {
        const indexer = new AstGraphIndexer(wsRoot, db);
        if (coldBuild === 'background' && db.getCounts().files === 0) {
            db.close();
            spawnBackgroundBuild(wsRoot, dbPath);
            return 0;
        }
        return work(indexer, db);
    }
    catch (err) {
        if (String(err?.message ?? err).includes('INDEX_BUILDING'))
            return 0;
        throw err;
    }
    finally {
        try {
            db.close();
        }
        catch {
            // already closed
        }
    }
}
/** Prefer the stable `~/.gemini/config/plugins/...` path in hints when it points at this build. */
function displayCliPath() {
    const cli = resolveCliEntrypoint();
    if (!cli)
        return null;
    const home = process.env.HOME;
    if (home) {
        const stable = path.join(home, '.gemini', 'config', 'plugins', 'ast-graph', 'dist', 'cli.js');
        try {
            if (fs.realpathSync(stable) === fs.realpathSync(cli))
                return '~/.gemini/config/plugins/ast-graph/dist/cli.js';
        }
        catch {
            // stable path not installed; fall through to the absolute path
        }
    }
    return cli;
}
/** Linked worktrees of `wsRoot` (excluding itself), capped so the hint stays small. */
export function listLinkedWorktrees(wsRoot, limit = 6) {
    try {
        const out = execFileSync('git', ['-C', wsRoot, 'worktree', 'list', '--porcelain'], {
            encoding: 'utf8',
            timeout: 1500,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const self = canonicalizeWorkspaceRoot(wsRoot);
        return out
            .split('\n')
            .filter((line) => line.startsWith('worktree '))
            .map((line) => line.slice('worktree '.length).trim())
            .filter((p) => p && fs.existsSync(p) && canonicalizeWorkspaceRoot(p) !== self)
            .slice(0, limit);
    }
    catch {
        return [];
    }
}
/** Short SessionStart hint: the exact CLI invocation, per-root `--workspace`, and delegation guidance. */
export function buildSessionHint(roots) {
    const cli = displayCliPath();
    if (!cli || roots.length === 0)
        return null;
    const lines = [
        `ast-graph is active for this session. Use the CLI via run_command instead of grep/sed/cat for code navigation:`,
        `  node ${cli} outline|symbol|refs|search|blast|tests <targets...> --workspace <root>`,
        `Roots: ${roots.map((r) => `--workspace ${r}`).join(' ; ')}`,
    ];
    const worktrees = roots.flatMap((r) => listLinkedWorktrees(r));
    if (worktrees.length > 0) {
        lines.push(`Worktrees have their own index; pass the worktree path itself: ${worktrees.map((w) => `--workspace ${w}`).join(' ; ')}`);
    }
    lines.push(`When briefing subagents or swarm workers, copy the CLI line above (with the worktree they work in) into the brief.`);
    return lines.join('\n');
}
function sessionHintEnabled(options) {
    if (options?.sessionHint !== undefined)
        return options.sessionHint;
    const env = (process.env.AST_GRAPH_SESSION_HINT ?? '').trim().toLowerCase();
    return !(env === '0' || env === 'false' || env === 'off');
}
/**
 * Injects the `ast-graph` CLI line into Antigravity `swarm` (`action: "add"`) briefs and
 * `invoke_subagent` prompts via `PreToolUse` `overwrite`, unless already present.
 */
export function buildDelegationBriefOverwrite(parsed, fallbackRoot) {
    if (parsed.harness !== 'antigravity')
        return undefined;
    const toolCall = parsed.rawPayload.toolCall;
    const args = toolCall?.args;
    if (!args)
        return undefined;
    let targetKey;
    let text;
    let isIsolated = false;
    if (parsed.toolName === 'swarm' && args.action === 'add' && typeof args.brief === 'string') {
        targetKey = 'brief';
        text = args.brief;
        isIsolated = args.workspace === 'share' || args.workspace === 'branch';
    }
    else if (parsed.toolName === 'invoke_subagent' && typeof args.Prompt === 'string') {
        targetKey = 'Prompt';
        text = args.Prompt;
        isIsolated = args.Workspace === 'share' || args.Workspace === 'branch';
    }
    else {
        return undefined;
    }
    // Skip if the coordinator already included an ast-graph CLI reference.
    if (/ast-graph[\/\\]dist[\/\\]cli\.js/i.test(text))
        return undefined;
    const cli = displayCliPath();
    if (!cli)
        return undefined;
    const rawRoot = parsed.workspacePaths[0] ?? fallbackRoot;
    const wsRoot = findEnclosingRepoRoot(rawRoot) ?? canonicalizeWorkspaceRoot(rawRoot);
    const workspaceArg = isIsolated ? '<your-worktree-cwd>' : wsRoot;
    const cliLine = `Code navigation: use \`node ${cli} outline|symbol|refs|search|blast|tests <targets...> --workspace ${workspaceArg}\` instead of grep/sed/cat.`;
    const updated = text.trimEnd().length > 0 ? `${text.trimEnd()}\n\n${cliLine}` : cliLine;
    return { [targetKey]: updated };
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
    const coldBuild = options?.coldBuild ?? 'inline';
    let filesUpdated = 0;
    const resolvedWorkspaces = [];
    if (lowerEvent === 'pre-tool-use' || lowerEvent === 'pretooluse') {
        if (parsed.commandLine) {
            const baseCwd = parsed.workspacePaths[0] ?? fallbackRoot;
            const actions = extractGitLifecycleActions(parsed.commandLine, baseCwd);
            for (const action of actions) {
                if (action.kind === 'worktree-remove') {
                    for (const wtPath of action.targetPaths) {
                        try {
                            const dotGit = path.join(wtPath, '.git');
                            const astDir = path.join(wtPath, '.ast-graph');
                            // Only pre-remove `.ast-graph` inside linked worktrees (`.git` pointer file) so user
                            // files remain protected by Git's dirty-worktree check without `.ast-graph/` blocking removal.
                            if (fs.existsSync(astDir) && fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
                                fs.rmSync(astDir, { recursive: true, force: true });
                                unregisterWorkspaceFromGlobalRegistry(wtPath);
                                resolvedWorkspaces.push(wtPath);
                            }
                        }
                        catch {
                            // non-fatal
                        }
                    }
                }
            }
        }
        const overwrite = buildDelegationBriefOverwrite(parsed, fallbackRoot);
        const durationMs = Number((performance.now() - startTime).toFixed(2));
        const stdoutJson = parsed.harness === 'antigravity'
            ? overwrite
                ? { decision: 'allow', overwrite }
                : { decision: 'allow' }
            : parsed.harness === 'claude-code'
                ? { continue: true }
                : {};
        return {
            harness: parsed.harness,
            eventType: parsed.eventType,
            workspaceRoots: resolvedWorkspaces,
            filesUpdated: 0,
            durationMs,
            stdoutJson,
        };
    }
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
                filesUpdated += runHookSync(wsRoot, dbPath, coldBuild, (indexer) => indexer.lazySyncIfDirty().filesUpdated);
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
                filesUpdated = runHookSync(wsRoot, dbPath, coldBuild, (indexer, db) => {
                    if (db.getCounts().files === 0) {
                        indexer.syncWorkspace({ full: true });
                    }
                    const delta = indexer.syncWorkspace({ full: false, targetPaths: [absTarget] });
                    return delta.filesUpdated + delta.filesDeleted;
                });
            }
        }
        else if (parsed.commandLine !== undefined) {
            if (!parsed.commandFailed) {
                const baseCwd = parsed.workspacePaths[0] ?? fallbackRoot;
                const actions = extractGitLifecycleActions(parsed.commandLine, baseCwd);
                for (const action of actions) {
                    if (action.kind === 'worktree-remove' || action.kind === 'worktree-prune') {
                        if (action.kind === 'worktree-remove') {
                            for (const wtPath of action.targetPaths) {
                                unregisterWorkspaceFromGlobalRegistry(wtPath);
                            }
                        }
                        pruneGlobalRegistry();
                        continue;
                    }
                    const rawTargetRoot = action.kind === 'head-mutation' ? action.repoPath : action.targetPath;
                    if (!fs.existsSync(rawTargetRoot))
                        continue;
                    const wsRoot = findEnclosingRepoRoot(rawTargetRoot) ?? canonicalizeWorkspaceRoot(rawTargetRoot);
                    if (!resolvedWorkspaces.includes(wsRoot)) {
                        resolvedWorkspaces.push(wsRoot);
                    }
                    const dbPath = options?.dbPath ?? path.join(wsRoot, '.ast-graph', 'ast.db');
                    if (coldBuild === 'background') {
                        assessWorkspace(wsRoot);
                        spawnBackgroundBuild(wsRoot, dbPath);
                    }
                    else {
                        filesUpdated += runHookSync(wsRoot, dbPath, coldBuild, (indexer) => {
                            const delta = indexer.lazySyncIfDirty();
                            return delta.filesUpdated + delta.filesDeleted;
                        });
                    }
                }
            }
        }
        else {
            const wsRoot = options?.workspaceRoot
                ? canonicalizeWorkspaceRoot(options.workspaceRoot)
                : findEnclosingRepoRoot(parsed.workspacePaths[0] ?? fallbackRoot) ?? fallbackRoot;
            resolvedWorkspaces.push(wsRoot);
            const dbPath = options?.dbPath ?? path.join(wsRoot, '.ast-graph', 'ast.db');
            filesUpdated = runHookSync(wsRoot, dbPath, coldBuild, (indexer) => {
                const delta = indexer.lazySyncIfDirty();
                return delta.filesUpdated + delta.filesDeleted;
            });
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
    const isSessionStart = lowerEvent === 'session-start' || lowerEvent === 'sessionstart';
    if (isSessionStart && sessionHintEnabled(options)) {
        const hint = buildSessionHint(resolvedWorkspaces);
        if (hint) {
            if (parsed.harness === 'antigravity') {
                stdoutJson = { injectSteps: [{ systemMessage: { systemMessage: hint } }] };
            }
            else if (parsed.harness === 'claude-code') {
                stdoutJson = {
                    continue: true,
                    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: hint },
                };
            }
        }
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
        .then((rawStdin) => handleHookInvocation(eventArg, rawStdin, { coldBuild: 'background' }))
        .then((result) => {
        process.stdout.write(`${JSON.stringify(result.stdoutJson)}\n`);
    })
        .catch(() => {
        // Never block the harness on an indexing failure; queries will surface real errors.
        const claude = Boolean(process.env.CLAUDE_PLUGIN_ROOT || process.env.CLAUDE_PROJECT_DIR);
        const isPreTool = eventArg.toLowerCase().startsWith('pre-tool') || eventArg.toLowerCase() === 'pretooluse';
        const fallback = claude
            ? '{"continue":true}\n'
            : isPreTool
                ? '{"decision":"allow"}\n'
                : '{}\n';
        process.stdout.write(fallback);
    });
}
//# sourceMappingURL=hook-handler.js.map