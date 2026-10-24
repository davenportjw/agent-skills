import http from 'node:http';
import { AstGraphDatabase } from './db.js';
import { AstGraphIndexer } from './indexer.js';
export interface SidecarDaemonOptions {
    workspaceRoot?: string;
    dbPath?: string;
    port?: number;
    host?: string;
    enableWatcher?: boolean;
}
export interface SidecarDaemonInstance {
    server: http.Server;
    db: AstGraphDatabase;
    indexer: AstGraphIndexer;
    port: number;
    close: () => Promise<void>;
}
export declare function startSidecarDaemon(options?: SidecarDaemonOptions): Promise<SidecarDaemonInstance>;
//# sourceMappingURL=daemon.d.ts.map