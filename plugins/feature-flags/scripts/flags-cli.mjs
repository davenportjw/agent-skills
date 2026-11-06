#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveFeatureFlags,
  setFeatureFlag,
  resetFeatureFlags,
} from './hook-handler.mjs';

const __filename = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const positional = [];
  let scope = 'workspace';
  let workspaceRoot = process.cwd();
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--global' || arg === '-g') {
      scope = 'global';
    } else if (arg === '--workspace' || arg === '-w') {
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        workspaceRoot = path.resolve(argv[++i]);
      }
      scope = 'workspace';
    } else if (arg === '--json') {
      json = true;
    } else {
      positional.push(arg);
    }
  }

  return { positional, scope, workspaceRoot, json };
}

export function runFlagsCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const cmd = (parsed.positional[0] || 'list').toLowerCase();
  const workspaceRoot = options.workspaceRoot || parsed.workspaceRoot;
  const globalConfigPath = options.globalConfigPath;
  const defaultsPath = options.defaultsPath;

  if (cmd === 'list' || cmd === 'status') {
    const resolved = resolveFeatureFlags({ workspaceRoot, globalConfigPath, defaultsPath });
    if (parsed.json) {
      return JSON.stringify(resolved, null, 2);
    }
    const lines = [
      '=== Feature Flags Status ===',
      `Workspace Config: ${resolved.paths.workspaceConfigPath || '(none)'}`,
      `Global Config:    ${resolved.paths.globalConfigPath}`,
      '',
    ];
    for (const [name, info] of Object.entries(resolved.details)) {
      const optsStr = info.options ? ` [options: ${info.options.join('|')}]` : '';
      lines.push(
        `- ${name}: ${JSON.stringify(info.value)} (source: ${info.source}, default: ${JSON.stringify(info.defaultValue)})${optsStr}`,
      );
      if (info.description) {
        lines.push(`    ${info.description}`);
      }
    }
    return lines.join('\n');
  }

  if (cmd === 'get') {
    const flagName = parsed.positional[1];
    if (!flagName) {
      throw new Error('Usage: flags-cli.mjs get <flag_name>');
    }
    const resolved = resolveFeatureFlags({ workspaceRoot, globalConfigPath, defaultsPath });
    if (!(flagName in resolved.values)) {
      throw new Error(`Unknown flag "${flagName}".`);
    }
    if (parsed.json) {
      return JSON.stringify(resolved.details[flagName], null, 2);
    }
    return `${flagName}=${JSON.stringify(resolved.values[flagName])} (source: ${resolved.sources[flagName]})`;
  }

  if (cmd === 'set' || cmd === 'enable' || cmd === 'disable') {
    const flagName = parsed.positional[1];
    if (!flagName) {
      throw new Error(`Usage: flags-cli.mjs ${cmd} <flag_name> ${cmd === 'set' ? '<value>' : ''}`);
    }
    const rawValue =
      cmd === 'enable' ? 'true' : cmd === 'disable' ? 'false' : parsed.positional[2];
    if (rawValue === undefined) {
      throw new Error('Usage: flags-cli.mjs set <flag_name> <value>');
    }
    const res = setFeatureFlag(flagName, rawValue, {
      scope: parsed.scope,
      workspaceRoot,
      globalConfigPath,
      defaultsPath,
    });
    if (parsed.json) {
      return JSON.stringify(res, null, 2);
    }
    return `Updated ${res.flagName}=${JSON.stringify(res.value)} (${res.scope} -> ${res.targetPath})`;
  }

  if (cmd === 'reset') {
    const flagName = parsed.positional[1] || '';
    const res = resetFeatureFlags(flagName, {
      scope: parsed.scope,
      workspaceRoot,
      globalConfigPath,
      defaultsPath,
    });
    if (parsed.json) {
      return JSON.stringify(res, null, 2);
    }
    return flagName
      ? `Reset flag "${flagName}" in ${res.scope} (${res.targetPath})`
      : `Cleared all ${res.scope} flag overrides (${res.targetPath})`;
  }

  throw new Error(
    `Unknown command "${cmd}". Supported commands: list, get, set, enable, disable, reset`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  try {
    const out = runFlagsCli(process.argv.slice(2));
    process.stdout.write(out + '\n');
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
