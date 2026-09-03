#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const zlib = require('zlib');

const VERSION = '1.2.1';
const PLUGIN_NAME = 'antigravity-cli-wakatime';
const GITHUB_DOWNLOAD_URL = 'https://github.com/wakatime/wakatime-cli/releases/latest/download';
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/wakatime/wakatime-cli/releases/latest';
const ANTIGRAVITY_CLI = Object.freeze({ product: 'antigravity-cli' });
const ANTIGRAVITY_DESKTOP = Object.freeze({ product: 'antigravity-desktop' });
const ANTIGRAVITY_IDE = Object.freeze({ product: 'antigravity-ide' });

main().catch((error) => {
  logException('ERROR', error);
  process.exit(0);
});

async function main() {
  if (process.argv.includes('--background')) {
    launchBackground();
    return;
  }

  const input = readInput();
  if (!input) return;

  if (getSetting('settings', 'debug') === 'true') {
    log('DEBUG', JSON.stringify(input, null, 2));
  }

  const eventName = getEventName(input);
  if (eventName === 'sessionStart') {
    await ensureWakatimeCli({ checkLatest: true });
    return;
  }

  if (!shouldSyncHeartbeat(eventName)) return;

  const cliPath = await ensureWakatimeCli({ checkLatest: eventName === 'preInvocation' && isInitialInvocation(input) });
  await syncAiHeartbeats(cliPath, input);
}

function launchBackground() {
  try {
    const stdin = fs.readFileSync(0);
    if (!stdin.length || !stdin.toString('utf8').trim()) {
      process.stdout.write('{}\n');
      return;
    }

    const eventName = getArgumentValue('--event');
    const args = [__filename];
    if (eventName) args.push(`--event=${eventName}`);

    const child = childProcess.spawn(process.execPath, args, {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      env: process.env,
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    child.unref();
  } catch (error) {
    logException('WARN', error);
  }

  process.stdout.write('{}\n');
}

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return undefined;
    return JSON.parse(raw);
  } catch (error) {
    logException('WARN', error);
    return undefined;
  }
}

function getEventName(input) {
  return normalizeEventName(getArgumentValue('--event') || input.hook_event_name || input.hookEventName || input.eventName || '');
}

function getArgumentValue(name) {
  const prefix = `${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : '';
}

function normalizeEventName(eventName) {
  const names = {
    PostToolUse: 'postToolUse',
    PreInvocation: 'preInvocation',
    SessionStart: 'sessionStart',
    session_started: 'sessionStart',
    UserPromptSubmit: 'userPromptSubmitted',
    userPromptSubmit: 'userPromptSubmitted',
  };
  return names[eventName] || eventName;
}

function shouldSyncHeartbeat(eventName) {
  return eventName === 'preInvocation' || eventName === 'postToolUse' || eventName === 'userPromptSubmitted';
}

function isInitialInvocation(input) {
  const invocationNum = Number(input.invocationNum);
  if (invocationNum === 0) return true;
  return invocationNum === 1 && Number(input.initialNumSteps || 0) <= 1;
}

function getProjectFolder(input) {
  if (input.cwd) return input.cwd;
  if (input.projectFolder) return input.projectFolder;
  if (Array.isArray(input.workspacePaths) && input.workspacePaths.length) return input.workspacePaths[0];
  return process.cwd();
}

async function syncAiHeartbeats(cliPath, input) {
  const runtime = getAntigravityRuntime(input);
  const antigravityVersion = await getAntigravityVersion(runtime);
  const plugin = `${runtime.product}/${antigravityVersion || 'unknown'} ${PLUGIN_NAME}/${VERSION}`;
  const args = ['--sync-ai-activity', '--plugin', plugin];
  const projectFolder = getProjectFolder(input);

  if (projectFolder) args.push('--project-folder', projectFolder);

  log('INFO', `Syncing AI heartbeats: ${formatArguments(cliPath, args)}`);

  try {
    const result = await execFile(cliPath, args, {
      windowsHide: true,
      env: getChildEnv(),
      timeout: 120000,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (output) log('WARN', output);
    log('INFO', `Synced AI heartbeats using ${plugin}`);
  } catch (error) {
    logException('WARN', error);
  }

  const modelToken = aiModelUserAgentToken(input.modelName || '');
  await sendEditedFileHeartbeats(runtime, plugin, projectFolder, modelToken);
}

const FILE_TOOL_NAMES = new Set(['replace_file_content', 'write_to_file', 'create_file']);
const MAX_FILE_HEARTBEATS = 50;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const MAX_TRANSCRIPTS_TO_SCAN = 3;

function getBrainDirs(runtime) {
  // Antigravity always writes its brain under the OS home dir, separate from
  // any WAKATIME_HOME override, so resolve it directly.
  const home = process.env[isWindows() ? 'USERPROFILE' : 'HOME'] || os.homedir() || process.cwd();
  // Mirrors wakatime-cli's Antigravity parser: transcripts live under
  // ~/.gemini/<product>/brain/<session>/.system_generated/logs/transcript.jsonl
  if (runtime === ANTIGRAVITY_IDE) return [path.join(home, '.gemini', 'antigravity-ide', 'brain')];
  if (runtime === ANTIGRAVITY_DESKTOP) return [path.join(home, '.gemini', 'antigravity', 'brain')];
  return [path.join(home, '.gemini', 'antigravity-cli', 'brain')];
}

const STATE_FILE = 'antigravity-cli-wakatime-state.json';
const API_BASE = process.env.WAKATIME_PLUGIN_API_URL || 'https://wakatime.com/api/v1';

async function sendEditedFileHeartbeats(runtime, plugin, projectFolder, modelToken) {
  const userAgent = modelToken ? `${modelToken} ${plugin}` : plugin;
  const { files, tokensIn, tokensOut, maxTimestamp, sessionId } = collectEditedFiles(runtime);
  if (!files.size) return;

  const apiKey = getApiKey();
  if (!apiKey) {
    log('WARN', 'No api_key in ~/.wakatime.cfg, skipping file heartbeats');
    return;
  }

  const entities = Array.from(files.entries()).slice(0, MAX_FILE_HEARTBEATS);
  const projectCache = new Map();
  let posted = 0;
  let failed = 0;
  for (const [idx, [entity, info]] of entities.entries()) {
    const payload = {
      entity,
      type: 'file',
      category: 'ai coding',
      time: Math.round(info.timestamp / 1000),
      is_write: true,
      lines: info.total,
      ai_line_changes: info.added - info.removed,
      // The user_agent carries the model token (e.g. gemini/3.8-flash-high);
      // the server parses it into ai_model / ai_model_version, which is what
      // powers WakaTime's model-specific token breakdowns.
      user_agent: userAgent,
    };
    // The CLI has no flags or extra-heartbeat keys for AI tokens (upstream
    // hardcodes empty tokens for this transcript format), so only a direct
    // API post can carry token counts. The transcript records no usage
    // numbers either, so tokens are estimated at ~4 chars per token, and the
    // whole event's estimate rides on the first file heartbeat.
    if (idx === 0) {
      payload.ai_input_tokens = tokensIn;
      payload.ai_output_tokens = tokensOut;
    }
    if (sessionId) payload.ai_session = sessionId;
    const project = getProjectNameForFile(entity, projectCache);
    if (project) payload.project = project;
    try {
      await postHeartbeat(apiKey, payload);
      posted++;
    } catch (error) {
      failed++;
      logException('WARN', error);
    }
  }
  log('INFO', `Posted ${posted} file heartbeats using ${plugin}`);
  if (failed) log('WARN', `${failed} file heartbeats failed to post`);
  if (maxTimestamp) saveLastEditTime(maxTimestamp);
}

function getApiKey() {
  const value = getSetting('settings', 'api_key');
  return value ? value.replace(/[\r\n ]/g, '') : '';
}

function postHeartbeat(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const requestModule = API_BASE.startsWith('http://') ? http : https;
    const req = requestModule.request(`${API_BASE}/users/current/heartbeats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity-cli-wakatime',
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`WakaTime API ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('WakaTime API timeout')));
    req.end(body);
  });
}

function getProjectNameForFile(entity, cache) {
  const dir = path.dirname(entity);
  if (cache.has(dir)) return cache.get(dir);
  let project = '';
  try {
    const result = childProcess.execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      windowsHide: true,
      timeout: 3000,
      encoding: 'utf8',
    });
    project = path.basename(result.trim());
  } catch (_) {}
  cache.set(dir, project);
  return project;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.round(String(text).length / 4));
}

// Port of wakatime-cli's aiModelUserAgentToken (pkg/ai/ai.go): normalizes a
// model id like "gemini-3.8-flash-high" into the "gemini/3.8-flash-high"
// token the server recognizes for model attribution.
function aiModelUserAgentToken(model, complexity) {
  if (typeof model !== 'string') return '';
  model = model.trim().replace(/\s+/g, '-').replace(/^\/+|\/+$/g, '');
  if (!model) return '';

  complexity = (typeof complexity === 'string' ? complexity : '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^[-_/.]+|[-_/.]+$/g, '');
  if (complexity && !model.toLowerCase().endsWith(`-${complexity.toLowerCase()}`)) {
    model += `-${complexity}`;
  }

  const firstSlash = model.indexOf('/');
  if (firstSlash > 0) {
    const product = model.slice(0, firstSlash);
    const version = model.slice(firstSlash + 1);
    if (product && version && /^[0-9]/.test(version[0])) return `${product}/${version}`;
  }

  if (model.lastIndexOf('/') !== -1) {
    model = model.slice(model.lastIndexOf('/') + 1).replace(/^[-_.]+|[-_.]+$/g, '');
  }

  const parts = model.split(/[-_]/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    for (let j = 0; j < part.length; j++) {
      const code = part.charCodeAt(j);
      if (code < 48 || code > 57) continue;
      if (j === 0) {
        if (i === 0) return '';
        return `${parts[i - 1]}/${parts.slice(i).join('-')}`;
      }
      let product = part.slice(0, j);
      if (product.toLowerCase() === 'v' && i > 0) product = parts[i - 1];
      let version = part.slice(j);
      if (i + 1 < parts.length) version += `-${parts.slice(i + 1).join('-')}`;
      return `${product}/${version}`;
    }
  }
  return '';
}

function getSessionId(transcriptPath) {
  // ~/.gemini/<product>/brain/<session>/.system_generated/logs/<file>
  return path.basename(path.dirname(path.dirname(path.dirname(transcriptPath))));
}

function getLastEditTime() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(getWakatimeDir(), STATE_FILE), 'utf8'));
    return state.lastEditTimeMillis || 0;
  } catch (_) {
    return 0;
  }
}

function saveLastEditTime(timestamp) {
  try {
    if (!timestamp) return;
    fs.writeFileSync(path.join(getWakatimeDir(), STATE_FILE), JSON.stringify({ lastEditTimeMillis: timestamp }));
    log('DEBUG', `Saved edit watermark ${timestamp}`);
  } catch (_) {}
}

function collectEditedFiles(runtime) {
  // abs file path -> { timestamp, added, removed, total } for its latest edit,
  // plus token estimates for steps since the watermark.
  const files = new Map();
  const tokens = { input: 0, output: 0, maxTs: 0 };
  let sessionId = '';
  // Only edits after the last sent event are included, otherwise the same
  // lines would be counted once per tool invocation. First run has no
  // watermark: start clean at now instead of replaying the whole session.
  let lastEditTime = getLastEditTime();
  if (!lastEditTime) lastEditTime = Date.now();
  for (const brainDir of getBrainDirs(runtime)) {
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(brainDir);
    } catch (_) {
      continue;
    }
    const transcripts = [];
    for (const sessionDir of sessionDirs) {
      const transcript = path.join(brainDir, sessionDir, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcript)) continue;
      try {
        if (fs.statSync(transcript).size > 0) transcripts.push(transcript);
      } catch (_) {}
    }
    // The active session always has the newest transcript, so only scan the
    // newest ones to keep per-event latency bounded (the hook timeout is 5s).
    transcripts.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const transcript of transcripts.slice(0, MAX_TRANSCRIPTS_TO_SCAN)) {
      scanTranscriptForEditedFiles(transcript, files, lastEditTime, tokens);
      if (!sessionId) sessionId = getSessionId(transcript);
    }
  }
  return { files, tokensIn: tokens.input, tokensOut: tokens.output, maxTimestamp: tokens.maxTs, sessionId };
}

function scanTranscriptForEditedFiles(transcriptPath, files, lastEditTime, tokens) {
  // wakatime-cli's own Antigravity parser only creates file heartbeats from
  // "CODE_ACTION" transcript lines, which this Antigravity CLI build never
  // writes: it records edits as tool_calls (e.g. replace_file_content or
  // write_to_file with a TargetFile arg). Parse those ourselves so real file
  // paths reach the dashboard instead of only session UUID entities.
  let buffer;
  try {
    const stat = fs.statSync(transcriptPath);
    // Edits can sit anywhere in the transcript, so parse the whole file when
    // it is small enough; fall back to the tail for very large transcripts.
    if (stat.size > 8 * 1024 * 1024) {
      const size = TRANSCRIPT_TAIL_BYTES;
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        buffer = fs.readSync(fd, Buffer.alloc(size), 0, size, stat.size - size).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      buffer = fs.readFileSync(transcriptPath, 'utf8');
    }
  } catch (_) {
    return;
  }
  // Drop the leading partial line (no JSON preamble survives in the tail).
  const firstNewline = buffer.indexOf('\n');
  const lines = firstNewline === -1 ? [buffer] : buffer.slice(firstNewline + 1).split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const timestamp = Date.parse(entry.created_at || '');
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp > tokens.maxTs) tokens.maxTs = timestamp;
    if (timestamp > lastEditTime) {
      // No usage metadata is persisted in this transcript format (upstream
      // wakatime-cli itself hardcodes empty AI token counts for Antigravity),
      // so estimate tokens at ~4 chars per token. Prompts and tool results
      // count as input; PLANNER_RESPONSE thinking/content as output.
      if (entry.source === 'USER_EXPLICIT' || (entry.source === 'MODEL' && entry.type === 'GENERIC')) {
        tokens.input += estimateTokens(entry.content);
      } else if (entry.source === 'MODEL') {
        tokens.output += estimateTokens(
          `${entry.thinking || ''}${entry.content || ''}${entry.tool_calls ? JSON.stringify(entry.tool_calls) : ''}`,
        );
      }
    }
    if (timestamp <= lastEditTime) continue; // only new edits since last event
    if (!Array.isArray(entry.tool_calls)) continue;
    for (const toolCall of entry.tool_calls) {
      if (!toolCall || !FILE_TOOL_NAMES.has(toolCall.name)) continue;
      // Transcript arg values are JSON-encoded strings: the real path
      // "/Users/<user>/proj/App.tsx" is stored as the value
      // "\"/Users/<user>/proj/App.tsx\"". Decode before use so the entity is
      // a real path, not a quoted one.
      const rawTarget = toolCall.args && toolCall.args.TargetFile;
      const target = decodeArgString(rawTarget);
      if (typeof target !== 'string' || !target.trim()) continue;
      const absTarget = path.resolve(target);
      if (!fs.existsSync(absTarget)) continue; // deleted files are not tracked
      const info = editLineChanges(toolCall.args);
      const previous = files.get(absTarget);
      if (previous === undefined || timestamp > previous.timestamp) {
        files.set(absTarget, { timestamp, ...info });
      }
    }
  }
}

function editLineChanges(args) {
  if (!args) return { added: 0, removed: 0, total: 0 };
  const before = decodeContentString(args.TargetContent);
  const after = decodeContentString(args.ReplacementContent || args.CodeContent || '');
  let total = countNewlines(after);
  if (before === '' && after === '') return { added: total, removed: 0, total };
  const changes = diffLineCounts(before, after);
  return { added: changes.added, removed: changes.removed, total };
}

function countNewlines(text) {
  if (!text) return 0;
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

// Counts added/removed lines between two texts using a classic LCS line diff.
// Falls back to the length delta for very large inputs.
function diffLineCounts(before, after) {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const n = oldLines.length;
  const m = newLines.length;

  if (n === 0) return { added: countNewlines(after), removed: 0 };
  if (m === 0) return { added: 0, removed: countNewlines(before) };
  if (n * m > 1500 * 1500) {
    return {
      added: Math.max(0, countNewlines(after) - countNewlines(before)),
      removed: Math.max(0, countNewlines(before) - countNewlines(after)),
    };
  }

  // lcs[i][j] = length of longest common subsequence of oldLines[0..i), newLines[0..j)
  const lcs = new Int32Array((n + 1) * (m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) lcs[i * (m + 1) + j] = lcs[(i - 1) * (m + 1) + j - 1] + 1;
      else lcs[i * (m + 1) + j] = Math.max(lcs[(i - 1) * (m + 1) + j], lcs[i * (m + 1) + j - 1]);
    }
  }
  return { added: m - lcs[n * (m + 1) + m], removed: n - lcs[n * (m + 1) + m] };
}

function decodeContentString(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      // The transcript stores content as a JSON-encoded string, but a stray
      // raw newline can make strict parsing fail; unescape manually instead.
      // eslint-disable-next-line no-control-regex
      return trimmed.slice(1, -1).replace(/\\(["\\/bfnrt])/g, (match, ch) => ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[ch] ?? ch));
    }
  }
  return value;
}

function decodeArgString(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch (_) {}
  }
  return value;
}

function getAntigravityRuntime(input) {
  const payloadPaths = [input.transcriptPath, input.transcript_path, input.artifactDirectoryPath, input.artifact_directory_path];

  for (const candidate of payloadPaths) {
    const runtime = getAntigravityRuntimeFromPath(candidate);
    if (runtime) return runtime;
  }

  // The plugin is always installed under ~/.gemini/config/plugins/, a path
  // shared by every Antigravity product, so its own location can't identify
  // the runtime (this used to make CLI runs report as antigravity-desktop).
  // Trust the product env vars instead, then default to the CLI product.
  if (process.env.ANTIGRAVITY_DESKTOP_VERSION) return ANTIGRAVITY_DESKTOP;
  if (process.env.ANTIGRAVITY_IDE_VERSION) return ANTIGRAVITY_IDE;
  return ANTIGRAVITY_CLI;
}

function getAntigravityRuntimeFromPath(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return undefined;

  const normalized = `/${candidate.replace(/\\/g, '/').toLowerCase()}/`.replace(/\/+/g, '/');
  if (normalized.includes('/.gemini/antigravity-cli/')) return ANTIGRAVITY_CLI;
  if (normalized.includes('/.gemini/antigravity-ide/')) return ANTIGRAVITY_IDE;
  if (normalized.includes('/.gemini/antigravity/')) return ANTIGRAVITY_DESKTOP;
  return undefined;
}

async function getAntigravityVersion(runtime) {
  let envVersion;
  if (runtime === ANTIGRAVITY_DESKTOP) {
    envVersion = process.env.ANTIGRAVITY_DESKTOP_VERSION || process.env.ANTIGRAVITY_VERSION;
  } else if (runtime === ANTIGRAVITY_IDE) {
    envVersion = process.env.ANTIGRAVITY_IDE_VERSION || process.env.ANTIGRAVITY_VERSION;
  } else {
    envVersion = process.env.ANTIGRAVITY_CLI_VERSION || process.env.AGY_CLI_VERSION;
  }
  if (envVersion) return envVersion;

  const installedVersion = getInstalledAntigravityVersion(runtime);
  if (installedVersion) return installedVersion;

  if (runtime !== ANTIGRAVITY_CLI) return '';

  try {
    const result = await execFile('agy', ['--version'], { windowsHide: true, timeout: 2000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    const match = output.match(/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/);
    return match ? match[1] : '';
  } catch (_) {
    return '';
  }
}

function getInstalledAntigravityVersion(runtime) {
  if (runtime === ANTIGRAVITY_DESKTOP) {
    return readFirstVersion(getAntigravityDesktopPlistPaths(), readPlistVersion);
  }
  if (runtime === ANTIGRAVITY_IDE) {
    return readFirstVersion(getAntigravityIdeProductPaths(), readJsonVersion);
  }
  return '';
}

function getAntigravityDesktopPlistPaths() {
  const home = getHomeDirectory();
  const paths = [];
  const executable = getAntigravityAgentExecutable('antigravity');
  const appIndex = executable.toLowerCase().indexOf('.app/');
  if (appIndex !== -1) {
    paths.push(path.normalize(`${executable.slice(0, appIndex + 4)}/Contents/Info.plist`));
  }
  paths.push(
    path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Info.plist'),
    path.join(path.parse(home).root, 'Applications', 'Antigravity.app', 'Contents', 'Info.plist'),
  );
  return paths;
}

function getAntigravityIdeProductPaths() {
  const home = getHomeDirectory();
  const paths = [];
  const executable = getAntigravityAgentExecutable('antigravity-ide');
  const extensionsIndex = executable.toLowerCase().indexOf('/extensions/');
  if (extensionsIndex !== -1) {
    paths.push(path.normalize(`${executable.slice(0, extensionsIndex)}/product.json`));
  }
  paths.push(
    path.join(home, 'Applications', 'Antigravity IDE.app', 'Contents', 'Resources', 'app', 'product.json'),
    path.join(path.parse(home).root, 'Applications', 'Antigravity IDE.app', 'Contents', 'Resources', 'app', 'product.json'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Antigravity IDE', 'resources', 'app', 'product.json'),
    path.join(path.parse(home).root, 'usr', 'share', 'antigravity-ide', 'resources', 'app', 'product.json'),
    path.join(path.parse(home).root, 'opt', 'Antigravity IDE', 'resources', 'app', 'product.json'),
  );
  return paths;
}

function getAntigravityAgentExecutable(appDir) {
  try {
    const script = fs.readFileSync(path.join(getHomeDirectory(), '.gemini', appDir, 'bin', 'agentapi'), 'utf8');
    const match = script.match(/\bexec\s+["']([^"']+)["']/);
    return match ? match[1].replace(/\\/g, '/') : '';
  } catch (_) {
    return '';
  }
}

function readFirstVersion(paths, reader) {
  for (const candidate of new Set(paths)) {
    const version = reader(candidate);
    if (version) return version;
  }
  return '';
}

function readPlistVersion(file) {
  try {
    const contents = fs.readFileSync(file, 'utf8');
    const match = contents.match(/<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i);
    return match ? normalizeVersion(match[1]) : '';
  } catch (_) {
    return '';
  }
}

function readJsonVersion(file) {
  try {
    return normalizeVersion(JSON.parse(fs.readFileSync(file, 'utf8')).version);
  } catch (_) {
    return '';
  }
}

function normalizeVersion(value) {
  for (const field of String(value || '').split(/\s+/)) {
    const version = field.replace(/^[vV,;()[\]{}]+|[,;()[\]{}]+$/g, '');
    if (/\d/.test(version) && /^[A-Za-z0-9._+-]+$/.test(version)) return version.toLowerCase();
  }
  return '';
}

async function ensureWakatimeCli(options = {}) {
  const checkLatest = options.checkLatest === true;
  const cliPath = getCliLocation();
  fs.mkdirSync(getWakatimeDir(), { recursive: true });

  if (!fs.existsSync(cliPath)) {
    await installCli();
    return cliPath;
  }

  let currentVersion;
  try {
    currentVersion = await getCurrentCliVersion(cliPath);
    log('DEBUG', `Current wakatime-cli version is ${currentVersion}`);
  } catch (_) {
    await installCli();
    return cliPath;
  }

  if (checkLatest && !(await isCliLatest(cliPath, currentVersion))) {
    await installCli();
  } else {
    ensureCliAlias(cliPath);
  }

  return cliPath;
}

async function getCurrentCliVersion(cliPath) {
  const versionResult = await execFile(cliPath, ['--version'], { windowsHide: true, timeout: 10000 });
  return `${versionResult.stdout || ''}${versionResult.stderr || ''}`.trim();
}

async function isCliLatest(cliPath, currentVersion) {
  try {
    if (currentVersion === undefined) currentVersion = await getCurrentCliVersion(cliPath);

    if (currentVersion === '<local-build>') {
      log('DEBUG', 'Skip checking for wakatime-cli updates because current version is <local-build>.');
      return true;
    }

    const legacyTag = legacyReleaseTag();
    if (legacyTag) return currentVersion === legacyTag;

    const latest = await getLatestCliVersion();
    if (!latest) return true;
    if (currentVersion === latest) {
      log('DEBUG', 'wakatime-cli is up to date');
      return true;
    }

    log('DEBUG', `Found an updated wakatime-cli ${latest}`);
    return false;
  } catch (_) {
    return false;
  }
}

async function getLatestCliVersion() {
  log('DEBUG', `Fetching latest wakatime-cli version from GitHub API: ${GITHUB_RELEASES_URL}`);

  try {
    const response = await getJson(GITHUB_RELEASES_URL);
    if (response.statusCode !== 200) {
      log('WARN', `GitHub API Response ${response.statusCode}`);
      return '';
    }

    const latest = response.body.tag_name || '';
    log('DEBUG', `Latest wakatime-cli version from GitHub: ${latest}`);
    return latest;
  } catch (error) {
    logException('WARN', error);
    return '';
  }
}

async function installCli() {
  const url = cliDownloadUrl();
  const zipFile = path.join(getWakatimeDir(), `wakatime-cli-${randomString()}.zip`);
  const cliPath = getCliLocation();
  const backupPath = `${cliPath}.backup`;

  log('DEBUG', `Downloading wakatime-cli from ${url}`);
  await downloadToFile(url, zipFile);

  try {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    if (fs.existsSync(cliPath)) fs.renameSync(cliPath, backupPath);
    extractZip(zipFile, getWakatimeDir());
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    if (!isWindows()) fs.chmodSync(cliPath, 0o755);
    ensureCliAlias(cliPath);
  } catch (error) {
    if (fs.existsSync(backupPath)) {
      if (fs.existsSync(cliPath)) fs.unlinkSync(cliPath);
      fs.renameSync(backupPath, cliPath);
    }
    throw error;
  } finally {
    try {
      fs.unlinkSync(zipFile);
    } catch (_) {}
  }
}

function ensureCliAlias(cliPath) {
  const alias = path.join(getWakatimeDir(), `wakatime-cli${isWindows() ? '.exe' : ''}`);
  try {
    if (fs.existsSync(alias)) {
      if (!isWindows() && fs.lstatSync(alias).isSymbolicLink()) return;
      fs.unlinkSync(alias);
    }
    if (isWindows()) {
      fs.copyFileSync(cliPath, alias);
      return;
    }
    fs.symlinkSync(cliPath, alias);
  } catch (error) {
    logException('WARN', error);
    try {
      fs.copyFileSync(cliPath, alias);
      if (!isWindows()) fs.chmodSync(alias, 0o755);
    } catch (copyError) {
      logException('WARN', copyError);
    }
  }
}

function getCliLocation() {
  const ext = isWindows() ? '.exe' : '';
  return path.join(getWakatimeDir(), `wakatime-cli-${osName()}-${architecture()}${ext}`);
}

function cliDownloadUrl() {
  const legacyTag = legacyReleaseTag();
  const platform = `${osName()}-${architecture()}`;

  if (legacyTag) {
    return `https://github.com/wakatime/wakatime-cli/releases/download/${legacyTag}/wakatime-cli-${platform}.zip`;
  }

  const validCombinations = new Set([
    'android-amd64',
    'android-arm64',
    'darwin-amd64',
    'darwin-arm64',
    'freebsd-386',
    'freebsd-amd64',
    'freebsd-arm',
    'linux-386',
    'linux-amd64',
    'linux-arm',
    'linux-arm64',
    'netbsd-386',
    'netbsd-amd64',
    'netbsd-arm',
    'openbsd-386',
    'openbsd-amd64',
    'openbsd-arm',
    'openbsd-arm64',
    'windows-386',
    'windows-amd64',
    'windows-arm64',
  ]);

  if (!validCombinations.has(platform)) reportMissingPlatformSupport();
  return `${GITHUB_DOWNLOAD_URL}/wakatime-cli-${platform}.zip`;
}

function reportMissingPlatformSupport() {
  const url = `https://api.wakatime.com/api/v1/cli-missing?osname=${encodeURIComponent(osName())}&architecture=${encodeURIComponent(
    architecture(),
  )}&plugin=antigravity-cli`;
  requestWithRedirects(url)
    .then((response) => response.resume())
    .catch(() => {});
}

function legacyReleaseTag() {
  if (osName() !== 'darwin') return undefined;
  return compareVersions(os.release(), '17.0.0') < 0 ? 'v1.39.1-alpha.1' : undefined;
}

function architecture() {
  const arch = os.arch();
  if (arch === 'ia32' || arch.includes('32')) return '386';
  if (arch === 'x64') return 'amd64';
  return arch;
}

function osName() {
  return isWindows() ? 'windows' : os.platform();
}

function isWindows() {
  return os.platform() === 'win32';
}

async function downloadToFile(url, outputFile) {
  const response = await requestWithRedirects(url);
  const statusCode = response.statusCode || 0;
  if (statusCode < 200 || statusCode >= 300) {
    response.resume();
    throw new Error(`Unexpected status code ${statusCode}`);
  }

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(outputFile);
    response.pipe(stream);
    response.once('error', reject);
    stream.once('error', reject);
    stream.once('finish', resolve);
  });
}

async function getJson(url) {
  const response = await requestWithRedirects(url);
  const chunks = [];
  for await (const chunk of response) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  return {
    statusCode: response.statusCode || 0,
    body: bodyText ? JSON.parse(bodyText) : {},
  };
}

async function requestWithRedirects(url, redirectsLeft = 5) {
  const response = await sendRequest(url);
  const statusCode = response.statusCode || 0;
  const location = response.headers.location;

  if (statusCode >= 300 && statusCode < 400 && location && redirectsLeft > 0) {
    response.resume();
    return requestWithRedirects(new URL(location, url).toString(), redirectsLeft - 1);
  }

  return response;
}

async function sendRequest(url) {
  const targetUrl = new URL(url);
  const proxy = getSetting('settings', 'proxy');
  const proxyUrl = proxy ? new URL(proxy) : undefined;
  const noSSLVerify = getSetting('settings', 'no_ssl_verify') === 'true';
  const rejectUnauthorized = !noSSLVerify;
  const headers = { 'User-Agent': 'github.com/wakatime/antigravity-cli-wakatime' };

  return new Promise(async (resolve, reject) => {
    let request;
    try {
      if (proxyUrl) log('DEBUG', `Using Proxy: ${proxyUrl.toString()}`);

      if (proxyUrl && targetUrl.protocol === 'https:') {
        const tunnel = await createProxyTunnel(proxyUrl, targetUrl, rejectUnauthorized);
        const secureSocket = tls.connect({ socket: tunnel, servername: targetUrl.hostname, rejectUnauthorized });
        secureSocket.once('error', reject);
        request = https.request(
          {
            host: targetUrl.hostname,
            port: targetUrl.port ? Number.parseInt(targetUrl.port, 10) : 443,
            path: `${targetUrl.pathname}${targetUrl.search}`,
            method: 'GET',
            headers,
            agent: false,
            createConnection: () => secureSocket,
          },
          resolve,
        );
      } else {
        const isHttpsRequest = proxyUrl ? proxyUrl.protocol === 'https:' : targetUrl.protocol === 'https:';
        const requestModule = isHttpsRequest ? https : http;
        const requestUrl = proxyUrl || targetUrl;
        const authHeader = proxyUrl ? getProxyAuthorizationHeader(proxyUrl) : undefined;
        const requestOptions = {
          host: requestUrl.hostname,
          port: requestUrl.port ? Number.parseInt(requestUrl.port, 10) : isHttpsRequest ? 443 : 80,
          path: proxyUrl ? targetUrl.toString() : `${targetUrl.pathname}${targetUrl.search}`,
          method: 'GET',
          headers: proxyUrl ? { Host: targetUrl.host, ...headers, ...(authHeader ? { 'Proxy-Authorization': authHeader } : {}) } : headers,
        };

        if (isHttpsRequest) {
          requestOptions.rejectUnauthorized = rejectUnauthorized;
          requestOptions.servername = requestUrl.hostname;
        }

        request = requestModule.request(requestOptions, resolve);
      }

      request.once('error', reject);
      request.end();
    } catch (error) {
      if (request) request.destroy();
      reject(error);
    }
  });
}

function createProxyTunnel(proxyUrl, targetUrl, rejectUnauthorized) {
  const proxyPort = proxyUrl.port ? Number.parseInt(proxyUrl.port, 10) : proxyUrl.protocol === 'https:' ? 443 : 80;
  const baseSocket =
    proxyUrl.protocol === 'https:'
      ? tls.connect({ host: proxyUrl.hostname, port: proxyPort, rejectUnauthorized, servername: proxyUrl.hostname })
      : net.connect(proxyPort, proxyUrl.hostname);

  return new Promise((resolve, reject) => {
    const auth = getProxyAuthorizationHeader(proxyUrl);
    let response = '';

    const cleanup = () => {
      baseSocket.removeListener('error', onError);
      baseSocket.removeListener('data', onData);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      response += chunk.toString('utf8');
      if (!response.includes('\r\n\r\n')) return;

      cleanup();
      const statusLine = response.split('\r\n', 1)[0];
      if (!statusLine.includes(' 200 ')) {
        baseSocket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${statusLine}`));
        return;
      }

      resolve(baseSocket);
    };

    const connectRequest = `CONNECT ${targetUrl.hostname}:${targetUrl.port || 443} HTTP/1.1\r\nHost: ${targetUrl.hostname}:${targetUrl.port || 443}\r\n${
      auth ? `Proxy-Authorization: ${auth}\r\n` : ''
    }Connection: close\r\n\r\n`;
    baseSocket.once('error', onError);
    baseSocket.on('data', onData);
    if (proxyUrl.protocol === 'https:') {
      baseSocket.once('secureConnect', () => baseSocket.write(connectRequest));
    } else {
      baseSocket.once('connect', () => baseSocket.write(connectRequest));
    }
  });
}

function getProxyAuthorizationHeader(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return undefined;
  return `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}`;
}

function extractZip(zipFile, outputDir) {
  const buffer = fs.readFileSync(zipFile);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === -1) throw new Error('Invalid zip file: missing central directory');

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;

  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid zip file: bad central directory header');

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLength);

    if (!fileName.endsWith('/')) extractZipEntry(buffer, outputDir, fileName, method, compressedSize, localHeaderOffset);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
}

function extractZipEntry(buffer, outputDir, fileName, method, compressedSize, localHeaderOffset) {
  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error('Invalid zip file: bad local file header');

  const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
  let data;

  if (method === 0) {
    data = compressed;
  } else if (method === 8) {
    data = zlib.inflateRawSync(compressed);
  } else {
    throw new Error(`Unsupported zip compression method ${method}`);
  }

  const outputFile = safeJoin(outputDir, fileName);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, data);
}

function findEndOfCentralDirectory(buffer) {
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 65557; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function safeJoin(root, fileName) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, fileName);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing to extract outside target directory: ${fileName}`);
  }
  return target;
}

function getSetting(section, key) {
  try {
    const content = fs.readFileSync(getConfigFile(), 'utf8');
    let currentSection = '';
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        currentSection = trimmed.slice(1, -1).toLowerCase();
        continue;
      }
      if (currentSection !== section) continue;
      const index = line.indexOf('=');
      if (index === -1) continue;
      if (line.slice(0, index).trim() === key)
        return line
          .slice(index + 1)
          .trim()
          .replace(/\0/g, '');
    }
  } catch (_) {}
  return undefined;
}

function getConfigFile() {
  return path.join(getHomeDirectory(), '.wakatime.cfg');
}

function getWakatimeDir() {
  return path.join(getHomeDirectory(), '.wakatime');
}

function getHomeDirectory() {
  const wakaHome = cleanEnvPath(process.env.WAKATIME_HOME);
  if (wakaHome && fs.existsSync(wakaHome)) return wakaHome;
  return process.env[isWindows() ? 'USERPROFILE' : 'HOME'] || os.homedir() || process.cwd();
}

function cleanEnvPath(value) {
  if (!value || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('${') && trimmed.endsWith('}')) return undefined;
  return trimmed;
}

function getChildEnv() {
  if (isWindows() || process.env.HOME || process.env.WAKATIME_HOME) return process.env;
  return { ...process.env, WAKATIME_HOME: getHomeDirectory() };
}

function log(level, message) {
  if (level === 'DEBUG' && getSetting('settings', 'debug') !== 'true') return;
  try {
    const logFile = path.join(getWakatimeDir(), 'antigravity-cli.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}][${level}] ${message}\n`);
  } catch (_) {}
}

function logException(level, error) {
  log(level, error && error.message ? error.message : String(error));
}

function execFile(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function formatArguments(binary, args) {
  return [binary, ...args].map((arg, index, list) => wrapArg(list[index - 1] === '--key' ? obfuscateKey(arg) : arg)).join(' ');
}

function wrapArg(arg) {
  return String(arg).includes(' ') ? `"${String(arg).replace(/"/g, '\\"')}"` : String(arg);
}

function obfuscateKey(key) {
  if (!key || key.length <= 4) return key || '';
  return `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXX${key.slice(-4)}`;
}

function compareVersions(left, right) {
  const leftParts = String(left)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i++) {
    if ((leftParts[i] || 0) < (rightParts[i] || 0)) return -1;
    if ((leftParts[i] || 0) > (rightParts[i] || 0)) return 1;
  }
  return 0;
}

function randomString() {
  return Math.random().toString(36).slice(2);
}
