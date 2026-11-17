import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const DEFAULT_HUNG_AFTER_MS = 10 * 60 * 1000;
export function syncLockPath(dbPath) {
    return path.join(path.dirname(dbPath), 'sync.lock');
}
function parseLock(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.pid === 'number' && typeof parsed.heartbeatAt === 'number') {
            return {
                pid: parsed.pid,
                host: String(parsed.host ?? ''),
                startedAt: Number(parsed.startedAt ?? parsed.heartbeatAt),
                heartbeatAt: parsed.heartbeatAt,
            };
        }
    }
    catch {
        // Legacy `pid:timestamp` format written by plugin <= 0.2.0
        const m = /^(\d+):(\d+)$/.exec(raw.trim());
        if (m) {
            const pid = Number(m[1]);
            const ts = Number(m[2]);
            return { pid, host: os.hostname(), startedAt: ts, heartbeatAt: ts };
        }
    }
    return null;
}
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        // EPERM: the process exists but belongs to another user.
        return err.code === 'EPERM';
    }
}
export function readSyncLock(lockPath) {
    try {
        return parseLock(fs.readFileSync(lockPath, 'utf8'));
    }
    catch {
        return null;
    }
}
/** Returns the live owner of the lock, or null when the lock is free, orphaned, or hung. */
export function activeLockOwner(lockPath, hungAfterMs = DEFAULT_HUNG_AFTER_MS) {
    if (!fs.existsSync(lockPath))
        return null;
    const info = readSyncLock(lockPath);
    if (!info) {
        // Unparseable (partially written) lock: honour it only while it is fresh.
        try {
            const age = Date.now() - fs.statSync(lockPath).mtimeMs;
            return age < 5000 ? { pid: -1, host: '', startedAt: 0, heartbeatAt: 0 } : null;
        }
        catch {
            return null;
        }
    }
    if (info.pid === process.pid)
        return info;
    // A lock from another host (network filesystem) cannot be liveness-checked; rely on heartbeat age.
    const sameHost = !info.host || info.host === os.hostname();
    const alive = sameHost ? isProcessAlive(info.pid) : true;
    if (!alive)
        return null;
    if (Date.now() - info.heartbeatAt > hungAfterMs)
        return null;
    return info;
}
/**
 * Try to acquire the lock without waiting. Returns null when another live process holds it.
 * Re-entrant within one process (nested syncs share the outer handle).
 */
export function tryAcquireSyncLock(dbPath, options = {}) {
    const lockPath = syncLockPath(dbPath);
    const hungAfterMs = options.hungAfterMs ?? DEFAULT_HUNG_AFTER_MS;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const now = Date.now();
    const info = { pid: process.pid, host: os.hostname(), startedAt: now, heartbeatAt: now };
    const owner = activeLockOwner(lockPath, hungAfterMs);
    if (owner) {
        if (owner.pid === process.pid) {
            return { lockPath, heartbeat: () => { }, release: () => { } };
        }
        return null;
    }
    if (fs.existsSync(lockPath)) {
        // Orphaned or hung lock: move it aside atomically so only one contender wins the takeover,
        // then confirm we moved the same stale lock we inspected (not a fresh one written meanwhile).
        const stalePath = `${lockPath}.stale-${process.pid}-${now}`;
        try {
            fs.renameSync(lockPath, stalePath);
        }
        catch {
            return null;
        }
        const moved = readSyncLock(stalePath);
        const movedIsLive = moved && moved.pid !== process.pid && activeLockOwner(stalePath, hungAfterMs);
        if (movedIsLive) {
            try {
                fs.renameSync(stalePath, lockPath);
            }
            catch {
                // Lost the race either way; leave it.
            }
            return null;
        }
        try {
            fs.unlinkSync(stalePath);
        }
        catch {
            // ignore
        }
    }
    try {
        fs.writeFileSync(lockPath, JSON.stringify(info), { flag: 'wx' });
    }
    catch {
        return null;
    }
    let released = false;
    return {
        lockPath,
        heartbeat: () => {
            if (released)
                return;
            info.heartbeatAt = Date.now();
            try {
                fs.writeFileSync(lockPath, JSON.stringify(info));
            }
            catch {
                // ignore
            }
        },
        release: () => {
            if (released)
                return;
            released = true;
            const current = readSyncLock(lockPath);
            if (current && current.pid !== process.pid)
                return; // never delete someone else's lock
            try {
                fs.unlinkSync(lockPath);
            }
            catch {
                // ignore
            }
        },
    };
}
//# sourceMappingURL=sync-lock.js.map