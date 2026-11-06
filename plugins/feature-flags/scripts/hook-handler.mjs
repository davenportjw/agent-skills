#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PLUGIN_ROOT = path.resolve(__dirname, '..');
export const DEFAULTS_PATH = path.join(PLUGIN_ROOT, 'defaults.json');

/**
 * Loads raw JSON object safely; returns empty object if missing or invalid.
 */
function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Loads the plugin's defaults.json schema.
 */
export function loadFlagSchema(defaultsPath = DEFAULTS_PATH) {
  const data = readJsonSafe(defaultsPath);
  return data.flags && typeof data.flags === 'object' ? data.flags : {};
}

/**
 * Coerces a raw value (from env var or CLI string) to match the schema type.
 */
export function coerceFlagValue(flagName, rawValue, schemaEntry) {
  if (!schemaEntry) {
    if (rawValue === 'true') return true;
    if (rawValue === 'false') return false;
    return rawValue;
  }
  if (schemaEntry.type === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    const normalized = String(rawValue).trim().toLowerCase();
    if (['true', '1', 'on', 'yes', 'enabled'].includes(normalized)) return true;
    if (['false', '0', 'off', 'no', 'disabled'].includes(normalized)) return false;
    throw new Error(`Invalid boolean value "${rawValue}" for flag "${flagName}". Expected true or false.`);
  }
  if (schemaEntry.type === 'enum') {
    const strVal = String(rawValue).trim();
    if (Array.isArray(schemaEntry.options) && !schemaEntry.options.includes(strVal)) {
      throw new Error(
        `Invalid value "${strVal}" for flag "${flagName}". Allowed options: ${schemaEntry.options.join(', ')}`,
      );
    }
    return strVal;
  }
  return rawValue;
}

/**
 * Parses AGY_PLUGIN_FLAGS="read_only_mode=true,release_channel=experimental"
 */
export function parseEnvFlags(envString = process.env.AGY_PLUGIN_FLAGS || '', schema = {}) {
  const result = {};
  if (!envString || !envString.trim()) return result;
  for (const pair of envString.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const rawVal = pair.slice(idx + 1).trim();
    if (!key) continue;
    try {
      result[key] = coerceFlagValue(key, rawVal, schema[key]);
    } catch {
      // Ignore malformed env override rather than crashing the hook
    }
  }
  return result;
}

/**
 * Resolves feature flags across the 4-tier hierarchy:
 *   1. Environment variable override (AGY_PLUGIN_FLAGS)
 *   2. Workspace config (<workspaceRoot>/.agents/feature-flags.json)
 *   3. User global config (~/.config/agent-skills/feature-flags.json)
 *   4. Plugin defaults (<pluginRoot>/defaults.json)
 */
export function resolveFeatureFlags(options = {}) {
  const schema = loadFlagSchema(options.defaultsPath || DEFAULTS_PATH);
  const globalConfigPath =
    options.globalConfigPath || path.join(os.homedir(), '.config', 'agent-skills', 'feature-flags.json');
  const workspaceRoot = options.workspaceRoot || '';
  const workspaceConfigPath = workspaceRoot
    ? path.join(workspaceRoot, '.agents', 'feature-flags.json')
    : '';

  const globalJson = readJsonSafe(globalConfigPath);
  const globalFlags =
    globalJson.flags && typeof globalJson.flags === 'object' ? globalJson.flags : globalJson;

  const workspaceJson = workspaceConfigPath ? readJsonSafe(workspaceConfigPath) : {};
  const workspaceFlags =
    workspaceJson.flags && typeof workspaceJson.flags === 'object' ? workspaceJson.flags : workspaceJson;

  const envFlags = parseEnvFlags(
    options.envFlags !== undefined ? options.envFlags : process.env.AGY_PLUGIN_FLAGS || '',
    schema,
  );

  const values = {};
  const sources = {};
  const details = {};

  const allKeys = new Set([
    ...Object.keys(schema),
    ...Object.keys(globalFlags),
    ...Object.keys(workspaceFlags),
    ...Object.keys(envFlags),
  ]);

  for (const key of allKeys) {
    const schemaEntry = schema[key];
    let val = schemaEntry ? schemaEntry.value : undefined;
    let source = 'default';

    if (globalFlags[key] !== undefined) {
      val = globalFlags[key];
      source = 'global';
    }
    if (workspaceFlags[key] !== undefined) {
      val = workspaceFlags[key];
      source = 'workspace';
    }
    if (envFlags[key] !== undefined) {
      val = envFlags[key];
      source = 'env';
    }

    values[key] = val;
    sources[key] = source;
    details[key] = {
      value: val,
      source,
      defaultValue: schemaEntry ? schemaEntry.value : undefined,
      type: schemaEntry ? schemaEntry.type : typeof val,
      options: schemaEntry?.options,
      description: schemaEntry?.description || '',
    };
  }

  return {
    values,
    sources,
    details,
    paths: {
      defaultsPath: options.defaultsPath || DEFAULTS_PATH,
      globalConfigPath,
      workspaceConfigPath: workspaceConfigPath || null,
    },
  };
}

/**
 * Extracts workspacePaths[0] (Antigravity) or cwd (Claude Code) from hook stdin JSON.
 * Solves Gotcha #4: hook working directory is the plugin folder, not the user's repo.
 */
export function parseHookStdin(rawStdin = '') {
  const trimmed = (rawStdin || '').trim();
  let payload = {};
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed;
      }
    } catch {
      payload = {};
    }
  }

  let workspaceRoot = '';
  if (Array.isArray(payload.workspacePaths) && typeof payload.workspacePaths[0] === 'string') {
    workspaceRoot = payload.workspacePaths[0].trim();
  } else if (typeof payload.cwd === 'string') {
    workspaceRoot = payload.cwd.trim();
  }

  const toolCall = payload.toolCall && typeof payload.toolCall === 'object' ? payload.toolCall : null;
  const toolName =
    (typeof toolCall?.name === 'string' ? toolCall.name : '') ||
    (typeof payload.tool_name === 'string' ? payload.tool_name : '');
  const toolArgs =
    (toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : null) ||
    (payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}) ||
    {};

  return {
    workspaceRoot,
    toolName,
    toolArgs,
    payload,
  };
}

const MUTATING_FILE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

const PROD_DEPLOY_REGEX =
  /\b(gcloud\s+(?:beta\s+|alpha\s+)?run\s+deploy|gcloud\s+app\s+deploy|terraform\s+apply|kubectl\s+apply|helm\s+(?:upgrade|install))\b/i;

const BARE_PYTEST_REGEX = /^(\s*)pytest(\s+.*|$)/;

/**
 * Builds the concise directive summary injected into the agent's context.
 */
export function buildActiveDirectives(values) {
  const directives = [];

  if (values.release_channel === 'experimental') {
    directives.push(
      '[FLAG release_channel=experimental]: Experimental plugin workflows are ENABLED. Prefer multi-agent fan-out, preview toolchains, and proactive architecture diagnostics.',
    );
  } else if (values.release_channel === 'beta') {
    directives.push(
      '[FLAG release_channel=beta]: Beta plugin workflows are ENABLED.',
    );
  }

  if (values.read_only_mode === true) {
    directives.push(
      '[FLAG read_only_mode=true]: Workspace is in READ-ONLY AUDIT MODE. Do NOT call write_file or edit_file (they are hard-blocked by PreToolUse). Only inspect, read, and analyze.',
    );
  }

  if (values.strict_tdd === true) {
    directives.push(
      '[FLAG strict_tdd=true]: Strict TDD mode is active. Write or update a failing unit test before modifying implementation files.',
    );
  }

  if (values.prod_deploy_guard === 'deny') {
    directives.push(
      '[FLAG prod_deploy_guard=deny]: Production deploy commands (gcloud run deploy, terraform apply, kubectl apply) are hard-blocked in this session.',
    );
  }

  return directives;
}

/**
 * Evaluates a lifecycle hook event (session-start, pre-invocation, pre-tool-use)
 * and returns the exact stdout JSON object expected by Antigravity.
 */
export function evaluateHookEvent(eventType, rawStdin = '', resolverOptions = {}) {
  const { workspaceRoot, toolName, toolArgs } = parseHookStdin(rawStdin);
  const resolved = resolveFeatureFlags({
    ...resolverOptions,
    workspaceRoot: resolverOptions.workspaceRoot ?? workspaceRoot,
  });
  const { values, sources } = resolved;
  const normalizedEvent = (eventType || '').toLowerCase();

  // 1. SessionStart: Inject one-time summary if any non-default flag is active
  if (normalizedEvent === 'session-start' || normalizedEvent === 'sessionstart') {
    const nonDefaultEntries = Object.entries(values).filter(([k]) => sources[k] !== 'default');
    const directives = buildActiveDirectives(values);

    if (nonDefaultEntries.length === 0 && directives.length === 0) {
      return {};
    }

    const flagSummary = Object.entries(values)
      .map(([k, v]) => `${k}=${JSON.stringify(v)} (${sources[k]})`)
      .join(', ');

    const systemText = [
      `Active feature-flags plugin configuration: ${flagSummary}.`,
      ...directives,
    ].join(' ');

    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: systemText,
          },
        },
      ],
    };
  }

  // 2. PreInvocation: Use ephemeralMessage (Gotcha #2) so transcript never bloats across turns,
  //    while mid-session flag changes take effect on the very next turn.
  if (normalizedEvent === 'pre-invocation' || normalizedEvent === 'preinvocation') {
    const directives = buildActiveDirectives(values);
    if (directives.length === 0) {
      return {};
    }
    return {
      injectSteps: [
        {
          ephemeralMessage: directives.join('\n'),
        },
      ],
    };
  }

  // 3. PreToolUse: Hard-gate tools or rewrite arguments based on active flags
  if (normalizedEvent === 'pre-tool-use' || normalizedEvent === 'pretooluse') {
    // 3a. Gate file mutations when read_only_mode=true
    if (values.read_only_mode === true && MUTATING_FILE_TOOLS.has(toolName)) {
      return {
        decision: 'deny',
        reason:
          'Blocked by feature-flags plugin: read_only_mode=true. Disable read_only_mode via `/feature-flags` or `node scripts/flags-cli.mjs set read_only_mode false` to modify files.',
      };
    }

    // 3b. Inspect run_command calls
    if (toolName === 'run_command') {
      const cmd = typeof toolArgs.CommandLine === 'string' ? toolArgs.CommandLine : '';

      // Check production deployment guard
      if (PROD_DEPLOY_REGEX.test(cmd)) {
        if (values.prod_deploy_guard === 'deny') {
          return {
            decision: 'deny',
            reason:
              'Blocked by feature-flags plugin: prod_deploy_guard="deny" prevents executing deployment commands (gcloud run deploy, terraform apply, kubectl apply).',
          };
        }
        if (values.prod_deploy_guard === 'ask') {
          return {
            decision: 'force_ask',
            reason:
              'feature-flags plugin (prod_deploy_guard="ask"): Confirm before running production deployment command.',
          };
        }
      }

      // Check prefer_uv_pytest argument overwrite
      if (values.prefer_uv_pytest === true && BARE_PYTEST_REGEX.test(cmd)) {
        const rewritten = cmd.replace(BARE_PYTEST_REGEX, '$1uv run pytest$2');
        return {
          decision: 'allow',
          reason: 'feature-flags plugin (prefer_uv_pytest=true): Rewrote bare pytest to uv run pytest.',
          overwrite: {
            CommandLine: rewritten,
          },
        };
      }
    }

    return {
      decision: 'allow',
    };
  }

  return {};
}

/**
 * Writes or updates a single flag in the workspace or global config file.
 */
export function setFeatureFlag(flagName, rawValue, options = {}) {
  const schema = loadFlagSchema(options.defaultsPath || DEFAULTS_PATH);
  const coerced = coerceFlagValue(flagName, rawValue, schema[flagName]);
  const scope = options.scope || 'workspace';
  const targetPath =
    scope === 'global'
      ? options.globalConfigPath || path.join(os.homedir(), '.config', 'agent-skills', 'feature-flags.json')
      : path.join(options.workspaceRoot || process.cwd(), '.agents', 'feature-flags.json');

  const existing = readJsonSafe(targetPath);
  const flagsMap =
    existing.flags && typeof existing.flags === 'object' ? { ...existing.flags } : { ...existing };
  delete flagsMap.flags;
  flagsMap[flagName] = coerced;

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify({ flags: flagsMap }, null, 2) + '\n', 'utf8');

  return {
    flagName,
    value: coerced,
    scope,
    targetPath,
  };
}

/**
 * Resets one or all flags in the chosen scope.
 */
export function resetFeatureFlags(flagName = '', options = {}) {
  const scope = options.scope || 'workspace';
  const targetPath =
    scope === 'global'
      ? options.globalConfigPath || path.join(os.homedir(), '.config', 'agent-skills', 'feature-flags.json')
      : path.join(options.workspaceRoot || process.cwd(), '.agents', 'feature-flags.json');

  if (!fs.existsSync(targetPath)) {
    return { scope, targetPath, cleared: false };
  }

  if (!flagName) {
    fs.rmSync(targetPath, { force: true });
    return { scope, targetPath, cleared: true };
  }

  const existing = readJsonSafe(targetPath);
  const flagsMap =
    existing.flags && typeof existing.flags === 'object' ? { ...existing.flags } : { ...existing };
  delete flagsMap.flags;
  delete flagsMap[flagName];

  fs.writeFileSync(targetPath, JSON.stringify({ flags: flagsMap }, null, 2) + '\n', 'utf8');
  return { scope, targetPath, flagName, cleared: true };
}

// Execute when invoked directly by Antigravity hooks.json
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const eventArg = process.argv[2] || 'pre-invocation';
  let stdinData = '';
  try {
    stdinData = fs.readFileSync(0, 'utf8');
  } catch {
    stdinData = '';
  }
  const output = evaluateHookEvent(eventArg, stdinData);
  process.stdout.write(JSON.stringify(output) + '\n');
}
