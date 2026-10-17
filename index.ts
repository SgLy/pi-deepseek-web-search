import {
  CONFIG_DIR_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  ProjectTrustStore,
  truncateHead,
  truncateLine,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Type, type Static } from "typebox";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const CONFIG_FILE = "pi-deepseek-web-search.json";
const ENV_API_KEY = "DEEPSEEK_API_KEY";
const QUERY_MAX_LENGTH = 128;
const COUNT_MIN = 1;
const COUNT_MAX = 50;
const URL_MAX_LENGTH = 8192;
const MAX_ERROR_DETAIL_LENGTH = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 5_000;

const CONFIG_FIELDS = ["apiKey", "baseUrl"] as const;

type ConfigField = (typeof CONFIG_FIELDS)[number];

function isConfigField(name: string): name is ConfigField {
  return (CONFIG_FIELDS as readonly string[]).includes(name);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

type BaseUrlParse = { ok: true; url: string } | { ok: false; problem: string };

function parseBaseUrl(raw: string): BaseUrlParse {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, problem: "must be an absolute URL with a host" };
  }
  if (!url.hostname) {
    return { ok: false, problem: "must be an absolute URL with a host" };
  }
  if (url.protocol !== "https:") {
    if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
      return {
        ok: false,
        problem:
          "must be an absolute https URL (http: is allowed only for localhost, 127.0.0.0/8 and [::1])",
      };
    }
  }
  if (url.username || url.password) {
    return { ok: false, problem: "must not include credentials (username or password)" };
  }
  if (url.search || url.hash || url.href.includes("?") || url.href.includes("#")) {
    return { ok: false, problem: "must not include a query string or fragment" };
  }
  return { ok: true, url: url.href.replace(/\/+$/, "") };
}

// Host projects without trust-requiring resources report isProjectTrusted() === true,
// so a project config also needs a saved trust decision.
interface ConfigScope {
  cwd: string;
  projectTrusted: boolean;
  trustProblem?: string;
}

interface ToolContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

/** The trust half of a config scope, cached per agent dir and working directory. */
type ProjectTrust = Omit<ConfigScope, "cwd">;

// ProjectTrustStore.get() creates the agent dir and takes a lock file on every call,
// and throws on a corrupt trust.json or a lost lock race. A broken trust store must
// not fail tool calls, so failures degrade to "not trusted" plus a [config] problem.
// The host messages can quote trust.json content, so only a coarse reason is reported.
function readProjectTrust(agentDir: string, cwd: string): ProjectTrust {
  try {
    return { projectTrusted: new ProjectTrustStore(agentDir).get(cwd) === true };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    const reason =
      code === undefined ? "trust store unreadable" : `trust store unavailable (${code})`;
    return {
      projectTrusted: false,
      trustProblem: `${join(agentDir, "trust.json")}: ${reason} (project config ignored)`,
    };
  }
}

function requestConfigScope(ctx: ToolContext, trustCache: Map<string, ProjectTrust>): ConfigScope {
  if (!ctx.isProjectTrusted()) return { cwd: ctx.cwd, projectTrusted: false };

  const agentDir = getAgentDir();
  const key = `${agentDir}\0${ctx.cwd}`;
  let trust = trustCache.get(key);
  if (trust === undefined) {
    trust = readProjectTrust(agentDir, ctx.cwd);
    trustCache.set(key, trust);
  }
  return { cwd: ctx.cwd, ...trust };
}

type ConfigValue<T> = { kind: "unset" } | { kind: "value"; value: T };

type ApiKeyChoice = ConfigValue<string>;

type BaseUrlChoice = ConfigValue<string> | { kind: "rejected" };

interface LoadedConfig {
  apiKey: ApiKeyChoice;
  baseUrl: BaseUrlChoice;
  problems: string[];
}

function loadConfig(scope: ConfigScope): LoadedConfig {
  const projectPath = join(scope.cwd, CONFIG_DIR_NAME, CONFIG_FILE);
  const paths = [join(getAgentDir(), CONFIG_FILE)];
  if (scope.projectTrusted) paths.push(projectPath);

  let apiKey: ApiKeyChoice = { kind: "unset" };
  let baseUrl: BaseUrlChoice = { kind: "unset" };
  const problems: string[] = scope.trustProblem === undefined ? [] : [scope.trustProblem];

  for (const path of paths) {
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch (error) {
      if (isNotFound(error)) continue;
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Do not print the parse error: it can quote file content, including the key.
      problems.push(`${path}: not valid JSON`);
      continue;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      problems.push(`${path}: expected a JSON object`);
      continue;
    }

    const source = parsed as Record<string, unknown>;
    for (const name of Object.keys(source)) {
      if (!isConfigField(name)) problems.push(`${path}: unknown field "${name}"`);
    }

    for (const name of CONFIG_FIELDS) {
      const raw = source[name];
      if (raw === undefined) continue;
      const value = readString(raw);
      if (value === undefined) {
        problems.push(`${path}: field "${name}" must be a string`);
        if (name === "baseUrl") baseUrl = { kind: "rejected" };
        continue;
      }
      if (name === "apiKey") {
        apiKey = { kind: "value", value };
        continue;
      }
      const parsed = parseBaseUrl(value);
      if (!parsed.ok) {
        problems.push(`${path}: field "baseUrl" ${parsed.problem}`);
        baseUrl = { kind: "rejected" };
      } else {
        baseUrl = { kind: "value", value: parsed.url };
      }
    }
  }

  if (!scope.projectTrusted && existsSync(projectPath)) {
    problems.push(`${projectPath}: ignored (project not trusted)`);
  }

  return { apiKey, baseUrl, problems };
}

function problemsNote(problems: readonly string[]): string {
  return problems.length === 0 ? "" : ` Config problems: ${problems.join("; ")}`;
}

function resolveBaseUrl(baseUrl: BaseUrlChoice, problems: readonly string[]): string {
  switch (baseUrl.kind) {
    case "value":
      return baseUrl.value;
    case "unset":
      return DEFAULT_BASE_URL;
    case "rejected":
      throw new Error(
        `No usable DeepSeek baseUrl: fix the "baseUrl" config problem.${problemsNote(problems)}`,
      );
  }
}

function getApiKey(configured: ApiKeyChoice, problems: readonly string[]): string {
  const configuredKey = configured.kind === "value" ? configured.value : undefined;
  const apiKey = configuredKey?.trim() || process.env[ENV_API_KEY]?.trim();
  if (!apiKey) {
    throw new Error(
      `DeepSeek API key is not configured. Add "apiKey" to ${join(getAgentDir(), CONFIG_FILE)} ` +
        `or set the ${ENV_API_KEY} environment variable.${problemsNote(problems)}`,
    );
  }
  return apiKey;
}

interface Settings {
  baseUrl: string;
  apiKey: string;
  problems: string[];
}

function resolveSettings(ctx: ToolContext, trustCache: Map<string, ProjectTrust>): Settings {
  const loaded = loadConfig(requestConfigScope(ctx, trustCache));
  return {
    baseUrl: resolveBaseUrl(loaded.baseUrl, loaded.problems),
    apiKey: getApiKey(loaded.apiKey, loaded.problems),
    problems: loaded.problems,
  };
}

function parseFetchUrl(raw: string): URL {
  if (raw.length > URL_MAX_LENGTH) {
    throw new Error(
      `Invalid url: must be at most ${URL_MAX_LENGTH} characters (got ${raw.length})`,
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid url: must be an absolute http(s) URL with a host and no credentials");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Invalid url: unsupported protocol "${url.protocol}" (only http and https are allowed)`,
    );
  }
  if (url.username || url.password) {
    throw new Error("Invalid url: must not include credentials (username or password)");
  }
  return url;
}

// truncateLine budgets characters, not bytes, and appends its own marker.
function takeLinePrefix(line: string, maxBytes: number): string | undefined {
  let maxChars = maxBytes;
  while (maxChars > 0) {
    const { text } = truncateLine(line, maxChars);
    const bytes = Buffer.byteLength(text, "utf-8");
    if (bytes <= maxBytes) return text;
    maxChars = Math.floor((maxChars * maxBytes) / bytes);
  }
  return undefined;
}

function getLine(text: string, index: number): string | undefined {
  let start = 0;
  for (let line = 0; line < index; line += 1) {
    const end = text.indexOf("\n", start);
    if (end === -1) return undefined;
    start = end + 1;
  }
  const end = text.indexOf("\n", start);
  return text.slice(start, end === -1 ? undefined : end);
}

function appendNotes(text: string, notes: readonly (string | undefined)[]): string {
  const present = notes.filter((note): note is string => note !== undefined);
  return present.length === 0 ? text : `${text}\n\n${present.join("\n")}`;
}

function configNote(problems: readonly string[]): string | undefined {
  return problems.length === 0 ? undefined : `[config] ${problems.join("; ")}`;
}

const TRUNCATION_RECOVERY_HINT =
  "Re-run with a smaller count, or use web_fetch on a listed URL to read one page in full.";

function truncateOutput(text: string): string {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return text;

  const separator = truncation.outputLines > 0 ? "\n" : "";
  const nextLine =
    truncation.truncatedBy === "bytes" ? getLine(text, truncation.outputLines) : undefined;
  const prefix =
    nextLine === undefined
      ? undefined
      : takeLinePrefix(nextLine, truncation.maxBytes - truncation.outputBytes - separator.length);
  const body = prefix === undefined ? truncation.content : truncation.content + separator + prefix;

  const shownLines = truncation.outputLines + (prefix === undefined ? 0 : 1);
  const lineNote =
    nextLine === undefined
      ? ""
      : ` Line ${truncation.outputLines + 1} is ` +
        `${formatSize(Buffer.byteLength(nextLine, "utf-8"))}, ` +
        (prefix === undefined
          ? "not shown."
          : `cut to ${formatSize(Buffer.byteLength(prefix, "utf-8"))}.`);

  return (
    body +
    `\n\n[Output truncated: ${shownLines} of ${truncation.totalLines} lines ` +
    `(${formatSize(Buffer.byteLength(body, "utf-8"))} of ${formatSize(truncation.totalBytes)}) ` +
    `shown.${lineNote}]\n${TRUNCATION_RECOVERY_HINT}`
  );
}

const RETRY_DELAYS_MS = [1_000, 2_000] as const;

// Official docs: retry 408/429/5xx after a wait; other 4xx are not retryable.
function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

type RetryAfter =
  | { kind: "none" }
  | { kind: "delay"; ms: number }
  | { kind: "invalid"; header: string };

function parseRetryAfter(header: string | null): RetryAfter {
  if (header === null) return { kind: "none" };
  const value = header.trim();
  if (value === "") return { kind: "none" };
  if (/^\d+$/.test(value)) return { kind: "delay", ms: Number(value) * 1_000 };
  const target = Date.parse(value);
  if (Number.isFinite(target)) {
    return { kind: "delay", ms: Math.max(0, target - Date.now()) };
  }
  return { kind: "invalid", header };
}

function truncateDetail(text: string): string {
  return text.length > MAX_ERROR_DETAIL_LENGTH
    ? `${text.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`
    : text;
}

interface ErrorBody {
  error?: { message?: unknown };
}

function parseErrorMessage(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const body: ErrorBody =
      typeof parsed === "object" && parsed !== null ? (parsed as ErrorBody) : {};
    const message = body.error?.message;
    return typeof message === "string" ? message.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function parseObjectBody(payload: unknown, endpoint: string): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(
      `${endpoint} returned a non-object body: ${truncateDetail(JSON.stringify(payload))}`,
    );
  }
  return payload as Record<string, unknown>;
}

function describeField(endpoint: string, field: string, at: string | undefined): string {
  return at === undefined ? `${endpoint} ${field}` : `${endpoint} ${at}.${field}`;
}

function readResponseString(
  source: Record<string, unknown>,
  field: string,
  endpoint: string,
  at?: string,
): string | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) return undefined;
  const value = readString(raw);
  if (value === undefined) {
    throw new Error(`${describeField(endpoint, field, at)} must be a string`);
  }
  return value;
}

function readResponseNumber(
  source: Record<string, unknown>,
  field: string,
  endpoint: string,
  at?: string,
): number | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`${describeField(endpoint, field, at)} must be a number`);
  }
  return raw;
}

interface ProgressCopy {
  running: string;
  retrying: string;
}

const SEARCH_PROGRESS: ProgressCopy = {
  running: "Searching...",
  retrying: "Retrying search",
};

const FETCH_PROGRESS: ProgressCopy = {
  running: "Fetching...",
  retrying: "Retrying fetch",
};

interface CallOptions<TDetails> {
  progress: ProgressCopy;
  endpoint: string;
  apiKey: string;
  body: unknown;
  signal: AbortSignal | undefined;
  /** Progress carries no details, so the callback always admits `undefined` there. */
  onUpdate: AgentToolUpdateCallback<TDetails | undefined> | undefined;
}

async function readBody(
  resp: Response,
  endpoint: string,
  signal: AbortSignal | undefined,
  timeout: AbortSignal,
): Promise<string> {
  try {
    return await resp.text();
  } catch (cause) {
    if (signal?.aborted) throw signal.reason ?? cause;
    if (timeout.aborted) {
      throw new Error(
        `${endpoint} timed out after ${REQUEST_TIMEOUT_MS}ms while reading the response`,
        { cause },
      );
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${endpoint} response body read failed: ${message}`, { cause });
  }
}

async function readErrorBody(
  resp: Response,
  endpoint: string,
  signal: AbortSignal | undefined,
  timeout: AbortSignal,
): Promise<string> {
  try {
    return await readBody(resp, endpoint, signal, timeout);
  } catch (error) {
    // A broken body must not hide the HTTP status; cancellation still propagates.
    if (signal?.aborted || timeout.aborted) throw error;
    return "";
  }
}

async function callDeepSeek<TDetails>(options: CallOptions<TDetails>): Promise<unknown> {
  const { progress, endpoint, apiKey, body, signal, onUpdate } = options;

  onUpdate?.({
    content: [{ type: "text", text: progress.running }],
    details: undefined,
  });

  let attempt = 0;
  for (;;) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? cause;
      if (timeout.aborted) {
        throw new Error(`${endpoint} request timed out after ${REQUEST_TIMEOUT_MS}ms`, { cause });
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${endpoint} request failed (attempt ${attempt + 1}): ${message}`, { cause });
    }

    if (resp.ok) {
      const raw = await readBody(resp, endpoint, signal, timeout);
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(
          `${endpoint} returned invalid JSON (HTTP ${resp.status}): ${truncateDetail(raw)}`,
        );
      }
    }

    const raw = await readErrorBody(resp, endpoint, signal, timeout);
    const baseDelayMs = RETRY_DELAYS_MS[attempt];
    if (isRetryable(resp.status) && baseDelayMs !== undefined) {
      const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
      if (retryAfter.kind === "invalid") {
        throw new Error(
          `${endpoint} returned HTTP ${resp.status} with an unparseable ` +
            `Retry-After header ${JSON.stringify(retryAfter.header)}; giving up`,
        );
      }
      const retryAfterMs = retryAfter.kind === "delay" ? retryAfter.ms : 0;
      if (retryAfterMs > MAX_RETRY_AFTER_MS) {
        throw new Error(
          `${endpoint} returned HTTP ${resp.status} asking to retry after ` +
            `${retryAfterMs / 1000}s, above the ${MAX_RETRY_AFTER_MS / 1000}s limit; giving up`,
        );
      }
      const delayMs = Math.max(baseDelayMs, retryAfterMs);
      attempt += 1;
      onUpdate?.({
        content: [
          {
            type: "text",
            text:
              `${progress.retrying} in ${delayMs / 1000}s ` +
              `(retry ${attempt}/${RETRY_DELAYS_MS.length})...`,
          },
        ],
        details: undefined,
      });
      await sleep(delayMs, undefined, { signal }).catch((cause: unknown) => {
        if (signal?.aborted) throw signal.reason ?? cause;
        throw cause;
      });
      continue;
    }

    const detail = parseErrorMessage(raw) ?? raw.trim();
    const attempts = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
    throw new Error(
      detail
        ? `HTTP ${resp.status}: ${truncateDetail(detail)}${attempts}`
        : `HTTP ${resp.status}${attempts}`,
    );
  }
}

const RESULT_STRING_FIELDS = [
  "title",
  "url",
  "snippet",
  "summary",
  "content",
  "site_name",
  "site_icon",
  "date",
] as const;

const RESULT_NUMBER_FIELDS = ["rerank_score", "authority"] as const;

type SearchResultItem = Partial<
  { [K in (typeof RESULT_STRING_FIELDS)[number]]: string } & {
    [K in (typeof RESULT_NUMBER_FIELDS)[number]]: number;
  }
>;

function decodeResult(
  record: Record<string, unknown>,
  endpoint: string,
  at: string,
): SearchResultItem {
  const result: SearchResultItem = {};
  for (const field of RESULT_STRING_FIELDS) {
    const value = readResponseString(record, field, endpoint, at);
    if (value !== undefined) result[field] = value;
  }
  for (const field of RESULT_NUMBER_FIELDS) {
    const value = readResponseNumber(record, field, endpoint, at);
    if (value !== undefined) result[field] = value;
  }
  return result;
}

type SearchResultSummary = Omit<SearchResultItem, "content">;

interface SearchDetails {
  query: string;
  resultCount: number;
  skippedCount: number;
  results: SearchResultSummary[];
}

interface FetchDetails {
  url: string;
  title: string;
}

interface ParsedResults {
  results: SearchResultItem[];
  skippedCount: number;
}

function parseResults(body: Record<string, unknown>, endpoint: string): ParsedResults {
  const value = body.results;
  if (value === undefined) {
    throw new Error(
      `${endpoint} returned no "results" field: ${truncateDetail(JSON.stringify(body))}`,
    );
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `${endpoint} returned a non-array "results": ${truncateDetail(JSON.stringify(value))}`,
    );
  }

  const results: SearchResultItem[] = [];
  let skippedCount = 0;
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      skippedCount += 1;
      continue;
    }
    // One malformed entry must not drop the other results; count it like a non-object entry.
    try {
      results.push(decodeResult(item as Record<string, unknown>, endpoint, `results[${index}]`));
    } catch {
      skippedCount += 1;
    }
  }
  return { results, skippedCount };
}

function renderSearchResult(result: SearchResultItem, index: number): string {
  const lines: string[] = [`[${index}] ${result.title?.trim() || "(untitled)"}`];

  const url = result.url?.trim();
  if (url) lines.push(url);

  const siteName = result.site_name?.trim();
  const date = result.date?.trim();
  const meta: string[] = [];
  if (siteName) meta.push(siteName);
  if (date) meta.push(date);
  if (typeof result.rerank_score === "number") {
    meta.push(`rerank ${result.rerank_score}`);
  }
  if (typeof result.authority === "number" && result.authority !== -1) {
    meta.push(`authority ${result.authority}`);
  }
  if (meta.length > 0) lines.push(meta.join(" · "));

  const summary = result.summary?.trim() || result.snippet?.trim();
  if (summary) {
    lines.push("");
    lines.push(summary);
  }

  const content = result.content?.trim();
  if (content) {
    lines.push("");
    lines.push(content);
  }

  return lines.join("\n");
}

const searchParameters = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: QUERY_MAX_LENGTH,
      pattern: "\\S",
      description: `Search query, 1-${QUERY_MAX_LENGTH} characters, not all whitespace. Supports search syntax including site:, -site:, "...", lang:, after: and before:, which is passed through unchanged.`,
    }),
    count: Type.Optional(
      Type.Integer({
        minimum: COUNT_MIN,
        maximum: COUNT_MAX,
        description: `Number of results to return, ${COUNT_MIN}-${COUNT_MAX}. Defaults to 10 when omitted.`,
      }),
    ),
    ori_question: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: QUERY_MAX_LENGTH,
        description: `The user's original question that triggered the search, 1-${QUERY_MAX_LENGTH} characters. Helps the service infer the intended search context. Omit when not needed.`,
      }),
    ),
    localization: Type.Optional(
      Type.String({
        description:
          "IP address used to prioritize localized search results. Defaults to an empty string.",
      }),
    ),
    need_content: Type.Optional(
      Type.Boolean({
        description:
          "When true, return extracted page body text in each result's content field. Defaults to false.",
      }),
    ),
  },
  { additionalProperties: false },
);

type SearchParameters = Static<typeof searchParameters>;

const fetchParameters = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: URL_MAX_LENGTH,
      description: `Absolute http(s) URL to fetch, at most ${URL_MAX_LENGTH} characters, with a host and no username/password.`,
    }),
  },
  { additionalProperties: false },
);

type FetchParameters = Static<typeof fetchParameters>;

export default function (pi: ExtensionAPI) {
  // The trust decision only changes across restarts, so read the trust store once
  // per (agent dir, cwd) instead of mkdir + lock on every tool call.
  const trustCache = new Map<string, ProjectTrust>();

  pi.registerTool<typeof searchParameters, SearchDetails | undefined>({
    name: "web_search",
    label: "Web Search",
    description:
      'Search the web with the official DeepSeek Search API. Returns ranked results with title, URL, snippet, model-oriented summary, publication date, site name, rerank score and authority; set need_content to also receive extracted page bodies. The query supports search syntax such as site:, -site:, "...", lang:, after: and before:.',
    promptSnippet:
      "Search the web for current information and external facts through DeepSeek Search.",
    promptGuidelines: [
      "Use web_search when the user wants web search, recent information, or external facts, and no URL is available yet.",
      'Keep web_search queries concise and search-like; split multi-topic requests into multiple calls. Search operators (site:, -site:, "...", lang:, after:, before:) are passed through unchanged.',
      `Set count (${COUNT_MIN}-${COUNT_MAX}) when a specific number of results is needed; omitting it uses the server default of 10, and need_content defaults to false.`,
      "Set need_content: true to receive extracted page bodies in the same call; otherwise use web_fetch when the full content of a specific result is needed.",
      "Pass ori_question with the user's original question when the search query alone loses context, so the service can resolve the search intent.",
    ],
    parameters: searchParameters,
    annotations: { readOnlyHint: true, openWorldHint: true },

    async execute(_toolCallId, params: SearchParameters, signal, onUpdate, ctx) {
      const { baseUrl, apiKey, problems } = resolveSettings(ctx, trustCache);
      const endpoint = `${baseUrl}/v1/tools/search`;

      const payload = await callDeepSeek({
        progress: SEARCH_PROGRESS,
        endpoint,
        apiKey,
        body: params,
        signal,
        onUpdate,
      });

      const { results, skippedCount } = parseResults(parseObjectBody(payload, endpoint), endpoint);
      const header = `Search: ${params.query}`;
      const body =
        results.length === 0
          ? "No results."
          : results.map((result, i) => renderSearchResult(result, i + 1)).join("\n\n");
      const skippedNote =
        skippedCount === 0
          ? undefined
          : `[skipped] ${skippedCount} malformed result ${skippedCount === 1 ? "entry" : "entries"}`;

      return {
        content: [
          {
            type: "text",
            text: appendNotes(truncateOutput(`${header}\n\n${body}`), [
              skippedNote,
              configNote(problems),
            ]),
          },
        ],
        details: {
          query: params.query,
          resultCount: results.length,
          skippedCount,
          results: results.map(({ content: _content, ...rest }) => rest),
        },
      };
    },
  });

  pi.registerTool<typeof fetchParameters, FetchDetails | undefined>({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a single web page by HTTP(S) URL with the official DeepSeek Fetch API and return its title plus the main content as Markdown. Use this when you already have a URL to read; use web_search first to discover URLs.",
    promptSnippet: "Fetch and extract page content from a known URL as Markdown.",
    promptGuidelines: [
      "Use web_fetch when the user provides a URL and wants its page content extracted.",
      "Use web_search first to discover URLs when the user has no URL yet, then web_fetch the selected page.",
      "When bodies for several search results are needed at once, prefer web_search with need_content: true.",
      "The URL must be an absolute http(s) URL with a host and without embedded credentials.",
    ],
    parameters: fetchParameters,
    annotations: { readOnlyHint: true, openWorldHint: true },

    async execute(_toolCallId, params: FetchParameters, signal, onUpdate, ctx) {
      const url = parseFetchUrl(params.url);
      const { baseUrl, apiKey, problems } = resolveSettings(ctx, trustCache);
      const endpoint = `${baseUrl}/v1/tools/fetch`;

      const payload = await callDeepSeek({
        progress: FETCH_PROGRESS,
        endpoint,
        apiKey,
        body: { url: url.href },
        signal,
        onUpdate,
      });

      const fetchResult = parseObjectBody(payload, endpoint);
      const title = readResponseString(fetchResult, "title", endpoint)?.trim() ?? "";
      const content = readResponseString(fetchResult, "content", endpoint)?.trim() ?? "";

      const lines: string[] = [];
      if (title) lines.push(title);
      lines.push(url.href);
      lines.push("");
      lines.push(content || "(no content extracted)");

      return {
        content: [
          {
            type: "text",
            text: appendNotes(truncateOutput(lines.join("\n")), [configNote(problems)]),
          },
        ],
        details: { url: url.href, title },
      };
    },
  });
}
