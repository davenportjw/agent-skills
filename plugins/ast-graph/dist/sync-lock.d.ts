/**
 * Cross-process single-writer lock for one repository index (`<repo>/.ast-graph/sync.lock`).
 *
 * Every harness (Antigravity, Claude Code, Codex CLI) spawns one stdio MCP process per session, and
 * hooks/daemons/CLI runs add more writers. Only one of them may sync a given repo at a time; the
 * others serve the last committed index (SQLite WAL readers never block) instead of queueing behind
 * `busy_timeout` or re-indexing the same files concurrently.
 *
 * Ownership is decided by PID liveness, not by lock age: a long cold sync (tens of seconds on large
 * monorepos) is never stolen while its owner is alive. Indexing is synchronous, so the owner refreshes
 * `heartbeatAt` between phases via `heartbeat()`; a lock whose live owner has not heartbeated for
 * `hungAfterMs` (default 10 min) is treated as hung and may be taken over.
 */
export interface SyncLockInfo {
    pid: number;
    host: string;
    startedAt: number;
    heartbeatAt: number;
}
export interface SyncLockHandle {
    readonly lockPath: string;
    heartbeat(): void;
    release(): void;
}
export declare const DEFAULT_HUNG_AFTER_MS: number;
export declare function syncLockPath(dbPath: string): string;
export declare function isProcessAlive(pid: number): boolean;
export declare function readSyncLock(lockPath: string): SyncLockInfo | null;
/** Returns the live owner of the lock, or null when the lock is free, orphaned, or hung. */
export declare function activeLockOwner(lockPath: string, hungAfterMs?: number): SyncLockInfo | null;
/**
 * Try to acquire the lock without waiting. Returns null when another live process holds it.
 * Re-entrant within one process (nested syncs share the outer handle).
 */
export declare function tryAcquireSyncLock(dbPath: string, options?: {
    hungAfterMs?: number;
}): SyncLockHandle | null;
//# sourceMappingURL=sync-lock.d.ts.map