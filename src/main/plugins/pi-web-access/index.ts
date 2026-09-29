import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import pLimit from "p-limit";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { normalizeFetchContentParams } from "./fetch-params.ts";
import { resolveAuthFetchProfile, type AuthFetchProfile } from "./auth-fetch.ts";
import { findContent, type FindMode } from "./content-find.ts";
import { answerFromPage } from "./page-query.ts";
import { clearCloneCache } from "./github-extract.ts";
import { ALL_SEARCH_PROVIDERS, assertSearchProviderSelectionAllowed, getAllowedSearchProviders, normalizeSearchProviderSelection, providerLabel, RESOLVED_SEARCH_PROVIDERS, search, type SearchProviderSelection, type ResolvedSearchProvider } from "./gemini-search.ts";
export type { ProviderAvailability } from "./gemini-search.ts";
import type { SearchResult } from "./perplexity.ts";
import { getWebSearchConfigPath, runWithProxy } from "./utils.ts";
import {
	createSessionStorage,
	generateId,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.ts";
import { activityMonitor } from "./activity.ts";
import { existsSync, readFileSync } from "node:fs";
import {
	buildResearchArtifact,
	withClaimAssessment,
	storeResearchArtifact,
	getResearchArtifact,
	type RecencyFilter,
	type ResearchArtifact,
} from "./source-check.ts";

// Match pi-ai's StringEnum without loading its compat barrel during registration.
function StringEnum<T extends string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

// Resolved per call: Pig exports PIG_DIR from the host process, which may be set after import.
const webSearchConfigPath = (): string => getWebSearchConfigPath();

let extractModulePromise: Promise<typeof import("./extract.ts")> | undefined;
async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	const extractModule = await (extractModulePromise ??= import("./extract.ts"));
	return extractModule.fetchAllContent(urls, signal, options);
}

function withRegisteredFetchOptions(
	options: ExtractOptions | undefined,
	toolNames: ExtractOptions["toolNames"],
	proxy?: string,
): ExtractOptions {
	return {
		...(options ?? {}),
		toolNames,
		...(proxy !== undefined ? { proxy } : {}),
	};
}

function isAbortError(err: unknown): boolean {
	return (err instanceof Error ? err.message : String(err)).toLowerCase().includes("abort");
}

interface WebSearchConfig {
	anysearchApiKey?: unknown;
	xcrawlApiKey?: unknown;
	brightdataApiKey?: unknown;
	brightdataSerpZone?: unknown;
	kagiApiKey?: unknown;
	ollamaApiKey?: unknown;
	serpbaseApiKey?: unknown;
	serpapiApiKey?: unknown;
	serperApiKey?: unknown;
	serplyApiKey?: unknown;
	youApiKey?: unknown;
	baizhiApiKey?: unknown;
	tinyfishApiKey?: unknown;
	valyuApiKey?: unknown;
	xaiApiKey?: unknown;
	provider?: unknown;
	searchProvider?: unknown;
	maxInlineContentChars?: unknown;
	fetch?: {
		defaultMode?: unknown;
		allowedModes?: unknown;
	};
	webSearch?: {
		enabled?: boolean;
		allowedProviders?: unknown;
	};
	tools?: Partial<Record<keyof ToolNames, { enabled?: boolean }>>;
	toolNames?: Partial<ToolNames>;
	ssrf?: {
		/** CIDR ranges exempted from the SSRF guard (e.g. fake-IP proxy ranges). */
		allowRanges?: string[];
		/** Skip local hostname DNS preflight when an HTTP(S)_PROXY env var applies. */
		trustEnvProxy?: boolean;
	};
}

function parseConfigRoot(raw: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${webSearchConfigPath()}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${webSearchConfigPath()}: expected a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

function loadConfig(): WebSearchConfig {
	if (!existsSync(webSearchConfigPath())) return {};
	return parseConfigRoot(readFileSync(webSearchConfigPath(), "utf-8")) as WebSearchConfig;
}

type ToolNames = {
	webSearch: string;
	sourceCheck: string;
	fetchContent: string;
	getSearchContent: string;
};

const DEFAULT_TOOL_NAMES: ToolNames = {
	webSearch: "web_search",
	sourceCheck: "source_check",
	fetchContent: "fetch_content",
	getSearchContent: "get_search_content",
};
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SEARCH_QUERY_CONCURRENCY = 3;
const FETCH_MODES = ["readable", "raw", "answer"] as const;
type FetchMode = typeof FETCH_MODES[number];
const FETCH_MODE_DESCRIPTIONS: Record<FetchMode, string> = {
	readable: "extract readable content as markdown",
	raw: "return the exact textual body using direct HTTP only",
	answer: "answer a prompt using only fetched content",
};

function resolveFetchModeConfig(config: WebSearchConfig): { defaultMode: FetchMode; allowedModes: FetchMode[] } {
	const configuredModes = config.fetch?.allowedModes ?? FETCH_MODES;
	if (!Array.isArray(configuredModes) || configuredModes.length === 0 || configuredModes.some(mode => !FETCH_MODES.includes(mode as FetchMode))) {
		throw new Error(`fetch.allowedModes in ${webSearchConfigPath()} must be a non-empty array containing only "readable", "raw", or "answer"`);
	}
	const allowedModes = configuredModes as FetchMode[];
	const duplicateMode = allowedModes.find((mode, index) => allowedModes.indexOf(mode) !== index);
	if (duplicateMode) {
		throw new Error(`fetch.allowedModes in ${webSearchConfigPath()} must not contain duplicates: "${duplicateMode}"`);
	}
	const defaultMode = config.fetch?.defaultMode ?? "readable";
	if (!allowedModes.includes(defaultMode as FetchMode)) {
		throw new Error(`fetch.defaultMode in ${webSearchConfigPath()} must be one of fetch.allowedModes`);
	}
	return { defaultMode: defaultMode as FetchMode, allowedModes };
}

// Limit each batch independently so separate Pi tool calls can still run in parallel.
function runSearchQueries<T>(queries: string[], run: (query: string, index: number) => Promise<T>): Promise<T[]> {
	const limit = pLimit(SEARCH_QUERY_CONCURRENCY);
	return Promise.all(queries.map((query, index) => limit(() => run(query, index))));
}

function searchProviderSchema(description: string, allowedProviders: readonly ResolvedSearchProvider[]) {
	return Type.Union([
		StringEnum(["auto", "all", ...allowedProviders]),
		Type.Array(StringEnum([...allowedProviders]), { minItems: 1 }),
	], { description });
}

function isToolEnabled(config: WebSearchConfig, key: keyof ToolNames): boolean {
	const override = config.tools?.[key]?.enabled;
	if (typeof override === "boolean") return override;
	return key !== "webSearch" && key !== "sourceCheck" || config.webSearch?.enabled !== false;
}

function joinToolNames(names: string[]): string {
	if (names.length === 0) return "stored content";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} or ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

function resolveToolNames(config: WebSearchConfig): ToolNames {
	if (config.toolNames !== undefined && (!config.toolNames || typeof config.toolNames !== "object" || Array.isArray(config.toolNames))) {
		throw new Error(`toolNames in ${webSearchConfigPath()} must be an object`);
	}
	const names = { ...DEFAULT_TOOL_NAMES };
	for (const key of Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>) {
		const value = config.toolNames?.[key];
		if (value === undefined) continue;
		if (typeof value !== "string") throw new Error(`toolNames.${key} in ${webSearchConfigPath()} must be a string`);
		const trimmed = value.trim();
		if (!TOOL_NAME_PATTERN.test(trimmed)) {
			throw new Error(`toolNames.${key} in ${webSearchConfigPath()} must start with a letter and contain only letters, numbers, underscores, or hyphens`);
		}
		names[key] = trimmed;
	}
	const registeredKeys = (Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>)
		.filter(key => isToolEnabled(config, key));
	const seen = new Map<string, keyof ToolNames>();
	for (const key of registeredKeys) {
		const name = names[key];
		if (name === "web_enable") throw new Error(`toolNames.${key} in ${webSearchConfigPath()} uses reserved loader name web_enable`);
		const previous = seen.get(name);
		if (previous) throw new Error(`toolNames.${key} duplicates toolNames.${previous} in ${webSearchConfigPath()}`);
		seen.set(name, key);
	}
	return names;
}

function loadConfigForExtensionInit(): WebSearchConfig {
	try {
		return loadConfig();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[pi-web-access] ${message}`);
		return {};
	}
}

function normalizeProviderInput(value: unknown, label = "provider"): SearchProviderSelection | undefined {
	if (value === undefined) return undefined;
	return normalizeSearchProviderSelection(value, label);
}

function resolveRequestedProvider(requested: unknown): SearchProviderSelection {
	const normalizedRequested = normalizeProviderInput(requested);
	if (normalizedRequested && normalizedRequested !== "auto") {
		assertSearchProviderSelectionAllowed(normalizedRequested, "Requested provider");
		return normalizedRequested;
	}
	const config = loadConfig();
	const provider = normalizeProviderInput(config.searchProvider ?? config.provider, `provider in ${webSearchConfigPath()}`) ?? "auto";
	assertSearchProviderSelectionAllowed(provider, `configured provider in ${webSearchConfigPath()}`);
	return provider;
}

function normalizeRecencyFilter(value: unknown): RecencyFilter | undefined {
	return value === "day" || value === "week" || value === "month" || value === "year"
		? value
		: undefined;
}

function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

// Some local models serialize a multi-query list into the single-string `query`
// field as a JSON array (query: "[\"a\", \"b\"]") instead of using the
// `queries` parameter. Forwarding that raw string verbatim makes every backend
// search for the literal array text and return zero results, with no signal to
// the model that its argument shape was wrong. Expand a string that parses as a
// JSON array of strings so each element is searched independently.
function expandQueryString(query: unknown): string[] {
	if (typeof query !== "string") return [];
	const trimmed = query.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			// Only expand an unambiguously string-only array. Mixed or non-string
			// arrays are kept as the literal query so we never silently drop
			// members or collapse them into an empty search.
			if (Array.isArray(parsed) && parsed.every((entry): entry is string => typeof entry === "string")) {
				return parsed
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0);
			}
		} catch {
			// Not JSON — treat as a literal query string.
		}
	}
	return [query];
}

const DEFAULT_MAX_INLINE_CONTENT_CHARS = 30_000;
const MIN_INLINE_CONTENT_CHARS = 1_000;
const MAX_INLINE_CONTENT_CHARS = 200_000;

function getMaxInlineContentChars(config = loadConfig()): number {
	const value = config.maxInlineContentChars;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < MIN_INLINE_CONTENT_CHARS) {
		return DEFAULT_MAX_INLINE_CONTENT_CHARS;
	}
	return Math.min(value, MAX_INLINE_CONTENT_CHARS);
}

function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
	return results.map(({ thumbnail, frames, ...rest }) => rest);
}

function initialContentSlice(content: string, maxChars: number): {
	text: string;
	endOffset: number;
	totalBytes: number;
	totalLines: number;
	shownBytes: number;
	shownLines: number;
} {
	let endOffset = Math.min(content.length, maxChars);
	if (endOffset < content.length) {
		const lineBreak = content.lastIndexOf("\n", endOffset);
		if (lineBreak >= Math.floor(maxChars * 0.8)) endOffset = lineBreak + 1;
	}
	const text = content.slice(0, endOffset);
	return {
		text,
		endOffset,
		totalBytes: Buffer.byteLength(content),
		totalLines: content.length === 0 ? 0 : content.split("\n").length,
		shownBytes: Buffer.byteLength(text),
		shownLines: text.length === 0 ? 0 : text.split("\n").length,
	};
}

function normalizeFindQueries(value: string | string[]): string[] {
	const queries = (Array.isArray(value) ? value : [value]).map(query => query.trim()).filter(Boolean);
	if (queries.length === 0) throw new Error("findText must contain at least one non-empty string");
	return queries;
}

interface GetSearchContentParams {
	responseId: string;
	query?: string;
	queryIndex?: number;
	url?: string;
	urlIndex?: number;
	offset?: number;
	limit?: number;
	findText?: string | string[];
	findMode?: FindMode;
}

type RawGetSearchContentParams = Omit<GetSearchContentParams, "findMode"> & { findMode?: unknown };

function normalizeFindMode(value: unknown): FindMode | undefined {
	if (value === undefined) return undefined;
	if (value === "exact" || value === "case-insensitive" || value === "fuzzy") return value;
	throw new Error('findMode must be "exact", "case-insensitive", or "fuzzy"');
}

function normalizeGetSearchContentParams(params: RawGetSearchContentParams): GetSearchContentParams {
	const normalized: GetSearchContentParams = { ...params, findMode: normalizeFindMode(params.findMode) };

	if (normalized.query?.trim() === "") delete normalized.query;
	if (normalized.url?.trim() === "") delete normalized.url;

	if (normalized.findText !== undefined) {
		delete normalized.offset;
		delete normalized.limit;
	}

	return normalized;
}

function formatInputValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	if (results.length === 0) {
		return answer ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.` : "No results found.";
	}
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function formatSourceCheckResult(artifact: ResearchArtifact, getSearchContentTool: string | null = DEFAULT_TOOL_NAMES.getSearchContent): string {
	const assessment = artifact.claims?.[0];
	const lines = [`# Source check: ${artifact.query}`, ""];
	if (assessment) {
		lines.push(`**Status:** ${assessment.status} (confidence ${assessment.confidence.toFixed(2)})`);
		lines.push(`**Rationale:** ${assessment.rationale}`);
		if (assessment.supporting_passages.length > 0) lines.push(`**Supporting passages:** ${assessment.supporting_passages.join(", ")}`);
		if (assessment.contradicting_passages.length > 0) lines.push(`**Contradicting passages:** ${assessment.contradicting_passages.join(", ")}`);
		lines.push("");
	}
	if (artifact.sources.length > 0) {
		lines.push("## Sources");
		for (const source of artifact.sources) lines.push(`${source.rank}. [${source.quality}] ${source.title}\n   ${source.url}`);
		lines.push("");
	}
	if (artifact.errors?.length) lines.push(`Search errors: ${artifact.errors.map((entry) => `${entry.query}: ${entry.error}`).join("; ")}`);
	lines.push(getSearchContentTool
		? `Artifact responseId: ${artifact.id} (retrievable via ${getSearchContentTool}).`
		: `Artifact responseId: ${artifact.id}. Content retrieval is not registered.`);
	return lines.join("\n");
}

function hasFullInlineCoverage(urls: string[], inlineContent: ExtractedContent[] | undefined): boolean {
	if (!inlineContent || inlineContent.length === 0) return false;
	const coveredUrls = new Set(inlineContent.map(c => c.url));
	return urls.every(url => coveredUrls.has(url));
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	const providers = queryData.providers ?? (queryData.provider ? [queryData.provider] : []);
	if (providers.length > 0) output += `**Provider${providers.length === 1 ? "" : "s"}:** ${providers.join(", ")}\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}${r.snippet ? `\n\n${r.snippet}` : ""}\n\n`;
	}
	return output;
}

function boundSearchPresentation(
	text: string,
	guidance: string,
	truncationGuidance: string,
	maxChars: number,
): { text: string; truncated: boolean; originalChars: number; returnedChars: number; omittedChars: number } {
	const fullText = `${text}${guidance}`;
	if (fullText.length <= maxChars) {
		return { text: fullText, truncated: false, originalChars: text.length, returnedChars: text.length, omittedChars: 0 };
	}
	const marker = `\n\n---\n[Output truncated.]${truncationGuidance}`;
	// Reserve marker space so the complete model-visible response never exceeds the configured ceiling.
	const prefixLength = maxChars - marker.length;
	const bounded = `${text.slice(0, prefixLength)}${marker}`;
	return {
		text: bounded,
		truncated: true,
		originalChars: text.length,
		returnedChars: prefixLength,
		omittedChars: text.length - prefixLength,
	};
}

export default function (pi: ExtensionAPI) {
	// Session-scoped state: the SDK caches this factory per cwd but runs it once per session, so
	// tabs that share a worktree must not share pending fetches or stored results.
	const storage = createSessionStorage();
	const pendingFetches = new Map<string, AbortController>();
	let sessionActive = false;

	function abortPendingFetches(): void {
		for (const controller of pendingFetches.values()) {
			controller.abort();
		}
		pendingFetches.clear();
	}

	function handleSessionChange(ctx: ExtensionContext): void {
		abortPendingFetches();
		clearCloneCache();
		sessionActive = true;
		storage.restoreFromSession(ctx);
		activityMonitor.clear();
	}

	function storeFetchResult(responseId: string, data: StoredSearchData & { type: "fetch"; urls: ExtractedContent[] }, authProfile?: AuthFetchProfile): boolean {
		if (authProfile?.cache === "off") return false;
		pi.appendEntry("web-search-results", storage.storeFetchedContentResult(responseId, data));
		return true;
	}

	const initConfig = loadConfigForExtensionInit();
	const fetchModeConfig = resolveFetchModeConfig(initConfig);
	const allowedSearchProviders = initConfig.webSearch?.allowedProviders === undefined ? RESOLVED_SEARCH_PROVIDERS : getAllowedSearchProviders();
	const allEligibleProviders = allowedSearchProviders.filter(provider => ALL_SEARCH_PROVIDERS.includes(provider));
	const allExcludedProviders = allowedSearchProviders.filter(provider => !ALL_SEARCH_PROVIDERS.includes(provider));
	const allPolicyDescription = allEligibleProviders.length === 0
		? `all has no eligible allowed providers; explicit-only allowed providers (${allExcludedProviders.map(providerLabel).join(", ")}) remain excluded`
		: allExcludedProviders.length > 0
		? `all searches eligible allowed providers (${allEligibleProviders.map(providerLabel).join(", ")}); explicit-only allowed providers (${allExcludedProviders.map(providerLabel).join(", ")}) remain excluded`
		: `all searches every eligible allowed provider (${allEligibleProviders.map(providerLabel).join(", ")})`;
	const toolNames = resolveToolNames(initConfig);
	const webSearchEnabled = isToolEnabled(initConfig, "webSearch");
	const sourceCheckEnabled = isToolEnabled(initConfig, "sourceCheck");
	const fetchContentEnabled = isToolEnabled(initConfig, "fetchContent");
	const getSearchContentEnabled = isToolEnabled(initConfig, "getSearchContent");
	// Names as registered this session, so fetch failure guidance never points
	// at tools that are disabled or were renamed after init.
	const registeredToolNames = {
		...(webSearchEnabled ? { webSearch: toolNames.webSearch } : {}),
		...(fetchContentEnabled ? { fetchContent: toolNames.fetchContent } : {}),
	};
	const storedContentSources = joinToolNames([
		...(webSearchEnabled ? [toolNames.webSearch] : []),
		...(sourceCheckEnabled ? [toolNames.sourceCheck] : []),
		...(fetchContentEnabled ? [toolNames.fetchContent] : []),
	]);
	const searchQueryDescription = webSearchEnabled
		? `Get content for this query (${toolNames.webSearch})`
		: "Get content for a stored search query";
	const fetchContentStorageNote = getSearchContentEnabled
		? `Full original content is stored for retrieval with ${toolNames.getSearchContent}.`
		: "Full original content is stored internally, but the retrieval tool is not registered.";
	const fetchModeDescription = fetchModeConfig.allowedModes
		.map(mode => `${mode}${mode === fetchModeConfig.defaultMode ? " (default)" : ""}: ${FETCH_MODE_DESCRIPTIONS[mode]}`)
		.join("; ");

	function startBackgroundFetch(urls: string[], proxy?: string): string | null {
		if (urls.length === 0) return null;
		const fetchId = generateId();
		const controller = new AbortController();
		pendingFetches.set(fetchId, controller);
		Promise.resolve()
			.then(() => runWithProxy(proxy, () => fetchAllContent(urls, controller.signal, withRegisteredFetchOptions(undefined, registeredToolNames, proxy))))
			.then((fetched) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const data = {
					id: fetchId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetched),
				} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
				pi.appendEntry("web-search-results", storage.storeFetchedContentResult(fetchId, data));
				const ok = fetched.filter(f => !f.error).length;
				const availability = ok === fetched.length
					? "Full page content now available."
					: ok > 0
						? "Partial page content now available."
						: "No page content was fetched. Stored fetch diagnostics are available.";
				pi.sendMessage(
					{
						customType: "web-search-content-ready",
						content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}]. ${availability}`,
						display: true,
					},
					{ triggerTurn: true },
				);
			})
			.catch((err) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const message = err instanceof Error ? err.message : String(err);
				const isAbort = (err instanceof Error && err.name === "AbortError") || message.toLowerCase().includes("abort");
				if (!isAbort) {
					pi.sendMessage(
						{
							customType: "web-search-error",
							content: `Content fetch failed [${fetchId}]: ${message}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}
			})
			.finally(() => { pendingFetches.delete(fetchId); });
		return fetchId;
	}

	function storeAndPublishSearch(results: QueryResultData[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id, type: "search", timestamp: Date.now(), queries: results,
		};
		storage.storeResult(id, data);
		pi.appendEntry("web-search-results", data);
		return id;
	}

	interface SearchReturnOptions {
		queryList: string[];
		results: QueryResultData[];
		urls: string[];
		includeContent: boolean;
		inlineContent?: ExtractedContent[];
		proxy?: string;
	}

	function buildSearchReturn(opts: SearchReturnOptions): AgentToolResult<Record<string, unknown>> {
		const sc = opts.results.filter(r => !r.error).length;
		const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

		const maxInlineContentChars = getMaxInlineContentChars(initConfig);
		let output = "";
		const providerNames = opts.results.map(result => {
			const providers = result.providers ?? (result.provider ? [result.provider] : []);
			return providers.join(", ") || "unknown";
		});
		output += opts.results.length === 1
			? `**Provider:** ${providerNames[0]}\n\n`
			: `**Providers used:** ${providerNames.map((name, index) => `Query ${index + 1}: ${name}`).join("; ")}\n\n`;
		for (const { query, answer, results, error } of opts.results) {
			if (opts.queryList.length > 1) {
				output += `## Query: "${query}"\n\n`;
			}
			if (error) output += `Error: ${error}\n\n`;
			else output += formatSearchSummary(results, answer) + "\n\n";
		}

		const hasInlineReady = hasFullInlineCoverage(opts.urls, opts.inlineContent);
		let fetchId: string | null = null;
		if (hasInlineReady && opts.inlineContent) {
			fetchId = generateId();
			const data = {
				id: fetchId,
				type: "fetch",
				timestamp: Date.now(),
				urls: opts.inlineContent,
			} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
			pi.appendEntry("web-search-results", storage.storeFetchedContentResult(fetchId, data));
		} else if (opts.includeContent) {
			fetchId = startBackgroundFetch(opts.urls, opts.proxy);
		}

		const searchId = storeAndPublishSearch(opts.results);
		const isBackgroundFetch = fetchId !== null && !hasInlineReady;
		const unboundedPresentation = output.trim();
		const buildGuidance = (forTruncation: boolean): string => {
			let value = "";
			if (hasInlineReady && opts.inlineContent && fetchId) {
				value += `\n---\nFull content for ${opts.inlineContent.length} sources is ready as responseId "${fetchId}". `;
				value += getSearchContentEnabled
					? `Use ${toolNames.getSearchContent}({ responseId: "${fetchId}", urlIndex: 0, offset: 0, limit: ${maxInlineContentChars} }) to retrieve the first bounded page.`
					: forTruncation ? `Enable ${toolNames.getSearchContent} to retrieve the full stored content.` : "";
			} else if (isBackgroundFetch && fetchId) {
				value += `\n---\nContent fetching in background as responseId "${fetchId}". Will notify when ready.`;
			}
			if (getSearchContentEnabled || forTruncation) {
				value += `\n---\nFull search results are stored as responseId "${searchId}". `;
				value += getSearchContentEnabled
					? `Use ${toolNames.getSearchContent}({ responseId: "${searchId}", queryIndex: 0, offset: 0, limit: ${maxInlineContentChars} }) to retrieve the first bounded page${opts.results.length > 1 ? `; repeat with queryIndex 1 through ${opts.results.length - 1}` : ""}.`
					: `Enable ${toolNames.getSearchContent} to retrieve the full stored results.`;
			}
			return value;
		};
		const presentation = boundSearchPresentation(unboundedPresentation, buildGuidance(false), buildGuidance(true), maxInlineContentChars);

		return {
			content: [{ type: "text", text: presentation.text }],
			details: {
				queries: opts.queryList,
				queryCount: opts.queryList.length,
				successfulQueries: sc,
				totalResults: tr,
				includeContent: opts.includeContent,
				fetchId,
				fetchUrls: isBackgroundFetch ? opts.urls : undefined,
				searchId,
				queryProviders: opts.results.map(result => ({
					query: result.query,
					providers: result.providers ?? (result.provider ? [result.provider] : []),
				})),
				truncated: presentation.truncated,
				originalChars: presentation.originalChars,
				returnedChars: presentation.returnedChars,
				omittedChars: presentation.omittedChars,
			},
		};
	}


	pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));

	pi.on("session_shutdown", () => {
		sessionActive = false;
		abortPendingFetches();
		clearCloneCache();
		storage.clear();
		activityMonitor.clear();
	});

	if (webSearchEnabled) pi.registerTool({
		name: toolNames.webSearch,
		label: "Web Search",
		description:
			`Search the web with ${allowedSearchProviders.map(providerLabel).join(", ")}. Provider arrays run simultaneously; ${allPolicyDescription}. It returns bounded source-linked search results or provider answers, identifies the providers used, and stores full results for retrieval by responseId. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query. When includeContent is true, full page content is fetched in the background. The configured provider is used when provider is omitted or set to auto; omit provider unless explicitly overriding it.`,
		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage. Omit provider unless explicitly overriding the configured default.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched concurrently (up to three at a time), each returning source-linked search results or a provider answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage. Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', 'React ecosystem size vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results)." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" }),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
			provider: Type.Optional(searchProviderSchema(`Search provider or non-empty list of allowed providers to search simultaneously; ${allPolicyDescription}; omit this field to use the configured provider, or use auto when none is configured`, allowedSearchProviders)),
			proxy: Type.Optional(Type.String({
				description: "http(s) or socks proxy URL (e.g. http://host:port or socks5h://host:port) used for every outbound request in this call (search APIs and content fetches). Node fetch ignores HTTP(S)_PROXY env vars, so set this (or `proxy` in web-search.json) when direct access is blocked; empty string forces direct access.",
			})),
		}),

		async execute(_callId, params, signal, onUpdate, ctx) {
			return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
				const rawQueryList: unknown[] = Array.isArray(params.queries)
					? params.queries
					: (params.query !== undefined ? expandQueryString(params.query) : []);
				const queryList = normalizeQueryList(rawQueryList);
				const recencyFilter = normalizeRecencyFilter(params.recencyFilter);

				if (queryList.length === 0) {
					return {
						content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
						details: { error: "No query provided" },
					};
				}

			let completedSearches = 0;
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];
			const resolvedProvider = resolveRequestedProvider(params.provider);

			const queryResponses = await runSearchQueries(queryList, async (query) => {
				signal?.throwIfAborted();
				onUpdate?.({
					content: [{ type: "text", text: `Searching "${query}" (${completedSearches}/${queryList.length} complete)...` }],
					details: { phase: "search", progress: completedSearches / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results, inlineContent, provider, providerResponses } = await search(query, {
						provider: resolvedProvider,
						numResults: params.numResults,
						recencyFilter,
						domainFilter: params.domainFilter,
						includeContent: params.includeContent,
						signal,
						extensionContext: ctx,
					});

					const providers = providerResponses?.map(response => response.provider) ?? [provider];
					return { result: { query, answer, results, error: null, provider, providers } satisfies QueryResultData, inlineContent };
				} catch (err) {
					if (signal?.aborted || isAbortError(err)) throw err;
					const message = err instanceof Error ? err.message : String(err);
					return {
						result: { query, answer: "", results: [], error: message } satisfies QueryResultData,
						inlineContent: undefined,
					};
				} finally {
					completedSearches++;
					if (!signal?.aborted) {
						onUpdate?.({
							content: [{ type: "text", text: `Completed ${completedSearches}/${queryList.length} searches.` }],
							details: { phase: "search", progress: completedSearches / queryList.length, currentQuery: query },
						});
					}
				}
			});
			const searchResults = queryResponses.map(response => response.result);
			for (const response of queryResponses) {
				for (const result of response.result.results) {
					if (!allUrls.includes(result.url)) allUrls.push(result.url);
				}
				if (response.inlineContent) allInlineContent.push(...response.inlineContent);
			}

			return buildSearchReturn({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent: allInlineContent.length > 0 ? allInlineContent : undefined,
				proxy: typeof params.proxy === "string" ? params.proxy : undefined,
			});
			});
		},

	});

	if (sourceCheckEnabled) pi.registerTool({
		name: toolNames.sourceCheck,
		label: "Source Check",
		description: "Gather web sources for a claim and return a bounded machine-readable research artifact with exact passage citations for manual review.",
		promptSnippet: "Gather structured source evidence and passage-level citations for manual semantic review of a claim.",
		parameters: Type.Object({
			claim: Type.String({ description: "The assertion to gather web sources for." }),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Search queries (default: the claim)." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)." })),
			fetchContent: Type.Optional(Type.Boolean({ description: "Fetch up to 5 result pages for exact passage extraction." })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Filter by recency." })),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains; prefix with - to exclude." })),
			provider: Type.Optional(searchProviderSchema(`Search provider or non-empty list of allowed providers to search simultaneously; ${allPolicyDescription}`, allowedSearchProviders)),
			proxy: Type.Optional(Type.String({
				description: "http(s) or socks proxy URL (e.g. http://host:port or socks5h://host:port) used for every outbound request in this call (search APIs and result-page fetches). Empty string forces direct access.",
			})),
		}),
		async execute(_callId, params, signal, _onUpdate, ctx) {
			return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
				const claim = typeof params.claim === "string" ? params.claim.trim() : "";
				if (!claim) {
					return { content: [{ type: "text", text: "Error: 'claim' is required." }], details: { error: "Missing claim" } };
				}

				const requestedQueries = Array.isArray(params.queries)
					? params.queries.filter((query): query is string => typeof query === "string").map((query) => query.trim()).filter(Boolean)
					: [];
				const queries = (requestedQueries.length > 0 ? requestedQueries : [claim]).slice(0, 8);
				const numResults = typeof params.numResults === "number" && Number.isFinite(params.numResults)
					? Math.min(20, Math.max(1, Math.floor(params.numResults)))
					: 5;
				const domainFilter = Array.isArray(params.domainFilter)
					? params.domainFilter.filter((domain): domain is string => typeof domain === "string")
					: undefined;
				const recencyFilter = normalizeRecencyFilter(params.recencyFilter);
				const resultsByUrl = new Map<string, SearchResult>();
				const summaries: string[] = [];
				const errors: Array<{ query: string; error: string }> = [];
				let provider: string | undefined;

				for (const query of queries) {
					if (signal?.aborted) break;
					try {
						const response = await search(query, {
							provider: resolveRequestedProvider(params.provider),
							numResults,
							recencyFilter,
							domainFilter,
							signal,
							extensionContext: ctx,
						});
						if (signal?.aborted) break;
						provider ??= response.provider;
						if (response.answer) summaries.push(`${query}: ${response.answer}`);
						for (const result of response.results) {
							if (!resultsByUrl.has(result.url)) resultsByUrl.set(result.url, result);
						}
					} catch (err) {
						if (signal?.aborted || isAbortError(err)) break;
						errors.push({ query, error: err instanceof Error ? err.message : String(err) });
					}
				}

				const results = [...resultsByUrl.values()].slice(0, 20).map((result, index) => ({ ...result, rank: index + 1 }));
				let fetched: ExtractedContent[] = [];
				if (params.fetchContent && results.length > 0) {
					const urls = results.slice(0, 5).map((result) => result.url);
					try {
						fetched = await fetchAllContent(urls, signal, withRegisteredFetchOptions(undefined, registeredToolNames, typeof params.proxy === "string" ? params.proxy : undefined));
					} catch (err) {
						if (signal?.aborted || isAbortError(err)) throw err;
						fetched = urls.map((url) => ({ url, title: "", content: "", error: err instanceof Error ? err.message : String(err) }));
					}
				}
				const artifact = withClaimAssessment(buildResearchArtifact({
					query: claim,
					provider,
					summary: summaries.length > 0 ? summaries.join("\n\n") : undefined,
					results,
					fetched,
					recency: recencyFilter,
					domainFilter,
				}), [claim]);
				if (errors.length > 0) artifact.errors = errors;
				storeResearchArtifact(storage, artifact);
				pi.appendEntry("web-search-results", {
					id: artifact.id,
					type: "research",
					timestamp: artifact.timestamp,
					artifact,
				});
				return {
					content: [{ type: "text", text: formatSourceCheckResult(artifact, getSearchContentEnabled ? toolNames.getSearchContent : null) }],
					details: { responseId: artifact.id, artifact, sourceCount: artifact.sources.length, passageCount: artifact.passages.length },
				};
			});
		},
	});

	if (fetchContentEnabled) pi.registerTool({
		name: toolNames.fetchContent,
		label: "Fetch Content",
		description: `Fetch URL(s). Available modes: ${fetchModeDescription}. Direct image URLs return resized image content when supported by the selected mode. Supports YouTube transcripts, GitHub repositories, PDFs, and local videos when supported by the selected mode. ${fetchContentStorageNote}`,
		promptSnippet:
			"Use to fetch URL content, direct images, GitHub repos, and videos.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			forceClone: Type.Optional(Type.Boolean({
				description: "Force cloning large GitHub repositories that exceed the size threshold",
			})),
			prompt: Type.Optional(Type.String({
				description: fetchModeConfig.allowedModes.includes("answer")
					? "Question or instruction for video analysis, or the page-local question required by answer mode."
					: "Question or instruction for video analysis.",
			})),
			mode: Type.Optional(StringEnum(fetchModeConfig.allowedModes, {
				description: `Fetch mode. ${fetchModeDescription}.`,
			})),
			...(fetchModeConfig.allowedModes.includes("answer") ? {
				answerModel: Type.Optional(Type.String({
					description: "Optional provider/model-id override for answer mode. Defaults to fetch.answerProvider + fetch.answerModel when configured, otherwise the current Pi model.",
				})),
			} : {}),
			timestamp: Type.Optional(Type.String({
				description: "Extract video frame(s) at a timestamp or time range. Single: '1:23:45', '23:45', or '85' (seconds). Range: '23:41-25:00' extracts evenly-spaced frames across that span (default 6). Use frames with ranges to control density; single+frames uses a fixed 5s interval. YouTube requires yt-dlp + ffmpeg; local videos require ffmpeg. Use a range when you know the approximate area but not the exact moment — you'll get a contact sheet to visually identify the right frame.",
			})),
			frames: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: 12,
				description: "Number of frames to extract. Use with timestamp range for custom density, with single timestamp to get N frames at 5s intervals, or alone to sample across the entire video. Requires yt-dlp + ffmpeg for YouTube, ffmpeg for local video.",
			})),
			model: Type.Optional(Type.String({
				description: "Override the Gemini model for video/YouTube analysis (e.g. 'gemini-3.6-flash'). Defaults to config or gemini-3.6-flash.",
			})),
			auth: Type.Optional(Type.Union([Type.String(), Type.Boolean()], {
				description: "Opt into an authFetch profile for local browser-cookie fetching. Use a profile name, or true only when exactly one profile exists.",
			})),
			proxy: Type.Optional(Type.String({
				description: "http(s) or socks proxy URL (e.g. http://host:port or socks5h://host:port) used for this fetch. Needed when the target is unreachable directly; localhost and NO_PROXY hosts always bypass the proxy. Empty string forces direct access.",
			})),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
			let normalized: ReturnType<typeof normalizeFetchContentParams>;
			try {
				normalized = normalizeFetchContentParams(params);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
			}
			const { urlList, options } = normalized;
			const mode = options.mode ?? fetchModeConfig.defaultMode;
			if (!fetchModeConfig.allowedModes.includes(mode)) {
				const error = `Fetch mode "${mode}" is disabled by fetch.allowedModes.`;
				return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
			}
			return runWithProxy(options.proxy, async () => {
				if (mode === "answer" && !options.prompt) {
					return { content: [{ type: "text", text: "Error: mode answer requires prompt." }], details: { error: "mode answer requires prompt" } };
				}
				if (mode === "raw" && (options.forceClone === true || options.timestamp || options.frames || options.prompt || options.model || options.answerModel)) {
					return { content: [{ type: "text", text: "Error: mode raw cannot be combined with forceClone, prompt, timestamp, frames, model, or answerModel." }], details: { error: "Incompatible raw mode options" } };
				}
				if (mode !== "answer" && options.answerModel) {
					return { content: [{ type: "text", text: "Error: answerModel requires mode answer." }], details: { error: "answerModel requires mode answer" } };
				}
				if (mode === "answer" && options.model) {
					return { content: [{ type: "text", text: "Error: use answerModel, not model, with mode answer." }], details: { error: "model is incompatible with mode answer" } };
				}
				if (mode === "answer" && options.auth !== undefined) {
					return { content: [{ type: "text", text: "Error: auth cannot be combined with mode answer." }], details: { error: "auth cannot be combined with mode answer" } };
				}
				let authFetchProfile: AuthFetchProfile | undefined;
				if (options.auth !== undefined) {
					try {
						authFetchProfile = resolveAuthFetchProfile(options.auth);
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
					}
				}
				if (urlList.length === 0) {
					return {
						content: [{ type: "text", text: "Error: No URL provided." }],
						details: { error: "No URL provided" },
					};
				}

				onUpdate?.({
					content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
					details: { phase: "fetch", progress: 0 },
				});

				const { answerModel: _answerModel, auth: _auth, ...extractionOptions } = { ...options, mode };
				const { prompt: _prompt, ...answerExtractionOptions } = extractionOptions;
				const fetchOptions = {
					...(mode === "answer" ? answerExtractionOptions : extractionOptions),
					...(authFetchProfile ? { authFetchProfile } : {}),
				};
				const fetchResults = await fetchAllContent(urlList, signal, withRegisteredFetchOptions(fetchOptions, registeredToolNames, options.proxy));
				const presentedResults = mode === "answer"
					? await Promise.all(fetchResults.map(async result => {
						if (result.error) return result;
						if (result.thumbnail || result.mimeType?.startsWith("image/")) {
							return { ...result, error: "Page answer requires textual fetched content" };
						}
						try {
							const answer = await answerFromPage({
								question: options.prompt!,
								pageText: result.content,
								sourceUrl: result.url,
								...(options.answerModel ? { model: options.answerModel } : {}),
							}, ctx, signal);
							return { ...result, content: answer.text };
						} catch (err) {
							return { ...result, error: `Page answer failed: ${err instanceof Error ? err.message : String(err)}` };
						}
					}))
					: fetchResults;
				const successful = presentedResults.filter((r) => !r.error).length;
				const totalChars = presentedResults.reduce((sum, r) => sum + r.content.length, 0);

				const responseId = generateId();
				const data = {
					id: responseId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetchResults),
				} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
				const storedContent = storeFetchResult(responseId, data, authFetchProfile);

				if (urlList.length === 1) {
					const result = presentedResults[0];
					if (result.error) {
						return {
							content: [{ type: "text", text: `Error: ${result.error}` }],
							details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, ...(storedContent ? { responseId } : {}), prompt: params.prompt, timestamp: params.timestamp, frames: params.frames },
						};
					}

					const fullLength = result.content.length;
					const slice = initialContentSlice(result.content, getMaxInlineContentChars());
					const truncated = slice.endOffset < fullLength;
					let output = slice.text;

					if (truncated) {
						output += `\n\n---\nShowing ${slice.endOffset} of ${fullLength} chars, ${slice.shownBytes} of ${slice.totalBytes} bytes, and ${slice.shownLines} of ${slice.totalLines} lines. `;
						output += storedContent
							? getSearchContentEnabled
								? `Use ${toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0, offset: ${slice.endOffset} }) for the next slice.`
								: "Content retrieval is not registered."
							: "Authenticated fetch cache is off; repeat the fetch to read more.";
					}

					const content: Array<TextContent | ImageContent> = [];
					if (result.frames?.length) {
						for (const frame of result.frames) {
							content.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
							content.push({ type: "text", text: `Frame at ${frame.timestamp}` });
						}
					} else if (result.thumbnail) {
						content.push({ type: "image", data: result.thumbnail.data, mimeType: result.thumbnail.mimeType });
					}
					content.push({ type: "text", text: output });

					const imageCount = (result.frames?.length ?? 0) + (result.thumbnail ? 1 : 0);
					return {
						content,
						details: {
							urls: urlList,
							urlCount: 1,
							successful: 1,
							totalChars: fullLength,
							title: result.title,
							...(storedContent ? { responseId } : {}),
							truncated,
							hasImage: imageCount > 0,
							imageCount,
							prompt: params.prompt,
							timestamp: params.timestamp,
							frames: params.frames,
							duration: result.duration,
							mode,
							mimeType: result.mimeType,
							status: result.status,
							totalBytes: slice.totalBytes,
							totalLines: slice.totalLines,
							shownBytes: slice.shownBytes,
							shownLines: slice.shownLines,
						},
					};
				}

				let output = "## Fetched URLs\n\n";
				for (const { url, title, content, error } of presentedResults) {
					if (error) {
						output += `- ${url}: Error - ${error}\n`;
					} else {
						output += `- ${title || url} (${content.length} chars)\n`;
					}
				}
				output += storedContent
					? getSearchContentEnabled
						? `\n---\nUse ${toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0 }) to retrieve bounded content slices.`
						: "\n---\nContent retrieval is not registered."
					: "\n---\nAuthenticated fetch cache is off; repeat the fetch to read content.";

				return {
					content: [{ type: "text", text: output }],
					details: { urls: urlList, urlCount: urlList.length, successful, totalChars, ...(storedContent ? { responseId } : {}) },
				};
			});
		},

	});

	if (getSearchContentEnabled) {
		const maxInlineContentChars = getMaxInlineContentChars(initConfig);
		pi.registerTool({
		name: toolNames.getSearchContent,
		label: "Get Search Content",
		description: `Retrieve bounded pages of full stored search results or fetched content, or find matching passages, from a previous ${storedContentSources} call.`,
		promptSnippet:
			`Use after ${storedContentSources} to retrieve stored content via responseId. Use findText to locate passages without paging through the full content.`,
		parameters: Type.Object({
			responseId: Type.String({ description: `The responseId from ${storedContentSources}` }),
			query: Type.Optional(Type.String({ description: searchQueryDescription })),
			queryIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for URL at index" })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset in stored search or fetched URL content (default 0). Ignored when findText is supplied." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxInlineContentChars, description: "Requested maximum stored-content characters (default and max use maxInlineContentChars). Search-page continuation guidance shares the global output cap and may reduce returnedChars. Ignored when findText is supplied." })),
			findText: Type.Optional(Type.Union([
				Type.String({ minLength: 1, maxLength: 500 }),
				Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
			], { description: "Text or texts to find in the selected stored content. When supplied, offset and limit are ignored." })),
			findMode: Type.Optional(StringEnum(["exact", "case-insensitive", "fuzzy"], { description: "Matching mode for findText (default: case-insensitive). Requires findText." })),
		}),

		async execute(_toolCallId, rawParams): Promise<AgentToolResult<Record<string, unknown>>> {
			const params = normalizeGetSearchContentParams(rawParams);
			if (params.findMode !== undefined && params.findText === undefined) {
				return {
					content: [{ type: "text", text: `findMode ${formatInputValue(params.findMode)} requires findText; provide findText or omit findMode.` }],
					details: { error: "findMode requires findText" },
				};
			}
			const data = storage.getResult(params.responseId);
			if (!data) {
				return {
					content: [{ type: "text", text: `Error: No stored results for responseId ${formatInputValue(params.responseId)}. Use a responseId returned by ${storedContentSources}.` }],
					details: { error: "Not found", responseId: params.responseId },
				};
			}

			if (data.type === "research") {
				const artifact = getResearchArtifact(storage, params.responseId);
				if (!artifact) {
					return {
						content: [{ type: "text", text: `Error: stored research artifact for responseId ${formatInputValue(params.responseId)} was not found. Use a responseId returned by ${storedContentSources}.` }],
						details: { error: "Artifact not found", responseId: params.responseId },
					};
				}
				const serialized = JSON.stringify(artifact, null, 2);
				if (params.findText !== undefined) {
					try {
						const found = findContent(serialized, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
						const { text, ...findDetails } = found;
						return {
							content: [{ type: "text", text }],
							details: { responseId: artifact.id, type: "research", contentLength: serialized.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
						};
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in research artifact for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
							details: { error, responseId: params.responseId, type: "research" },
						};
					}
				}
				const offset = params.offset ?? 0;
				const limit = params.limit ?? maxInlineContentChars;
				if (!Number.isInteger(offset) || offset < 0) {
					return {
						content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for responseId ${formatInputValue(params.responseId)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
						details: { error: "Invalid offset", offset },
					};
				}
				if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
					return {
						content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for responseId ${formatInputValue(params.responseId)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
						details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
					};
				}
				if (offset > serialized.length) {
					return {
						content: [{ type: "text", text: `Offset ${offset} is out of range for responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${serialized.length}. Use an offset within that range.` }],
						details: { error: "Offset out of range", offset, contentLength: serialized.length },
					};
				}
				const endOffset = Math.min(offset + limit, serialized.length);
				const artifactSlice = serialized.slice(offset, endOffset);
				const hasMore = endOffset < serialized.length;
				return {
					content: [{ type: "text", text: artifactSlice }],
					details: { responseId: artifact.id, type: "research", contentLength: serialized.length, offset, limit, returnedChars: artifactSlice.length, nextOffset: hasMore ? endOffset : null, truncated: hasMore },
				};
			}

			if (data.type === "search" && data.queries) {
				let queryData: QueryResultData | undefined;

				if (params.query !== undefined) {
					queryData = data.queries.find((q) => q.query === params.query);
					if (!queryData) {
						const available = data.queries.map((q) => `"${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query ${formatInputValue(params.query)} was not found for responseId ${formatInputValue(params.responseId)}. Received query=${formatInputValue(params.query)}. Available queries: ${available || "none"}. Use one of the available queries or queryIndex.` }],
							details: { error: "Query not found" },
						};
					}
				} else if (params.queryIndex !== undefined) {
					queryData = data.queries[params.queryIndex];
					if (!queryData) {
						const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query index ${formatInputValue(params.queryIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received queryIndex=${formatInputValue(params.queryIndex)}; valid indexes are 0-${data.queries.length - 1}. Available queries: ${available || "none"}. Use one of the available indexes.` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Specify query or queryIndex for responseId ${formatInputValue(params.responseId)}. Available queries: ${available || "none"}.` }],
						details: { error: "No query specified" },
					};
				}

				if (queryData.error) {
					return {
						content: [{ type: "text", text: `Error retrieving query ${formatInputValue(queryData.query)} from responseId ${formatInputValue(params.responseId)}: ${queryData.error}. Check the stored search result and retry with another query or queryIndex if needed.` }],
						details: { error: queryData.error, query: queryData.query },
					};
				}

				const fullResults = formatFullResults(queryData);
				if (params.findText !== undefined) {
					try {
						const found = findContent(fullResults, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
						const { text, ...findDetails } = found;
						return {
							content: [{ type: "text", text }],
							details: { responseId: params.responseId, query: queryData.query, resultCount: queryData.results.length, contentLength: fullResults.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
						};
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in query ${formatInputValue(queryData.query)} for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
							details: { error, query: queryData.query },
						};
					}
				}

				const offset = params.offset ?? 0;
				const limit = params.limit ?? maxInlineContentChars;
				if (!Number.isInteger(offset) || offset < 0) {
					return {
						content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for query ${formatInputValue(queryData.query)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
						details: { error: "Invalid offset", offset },
					};
				}
				if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
					return {
						content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for query ${formatInputValue(queryData.query)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
						details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
					};
				}
				if (offset > fullResults.length) {
					return {
						content: [{ type: "text", text: `Offset ${offset} is out of range for query ${formatInputValue(queryData.query)} in responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${fullResults.length}. Use an offset within that range.` }],
						details: { error: "Offset out of range", offset, contentLength: fullResults.length },
					};
				}
				const queryIndex = data.queries.indexOf(queryData);
				let returnedChars = Math.min(limit, fullResults.length - offset);
				let endOffset = offset + returnedChars;
				let continuation = "";
				while (endOffset < fullResults.length) {
					continuation = `\n\n---\nShowing chars ${offset}-${endOffset} of ${fullResults.length}. Use ${toolNames.getSearchContent}({ responseId: "${params.responseId}", queryIndex: ${queryIndex}, offset: ${endOffset}, limit: ${limit} }) for the next slice.`;
					const overflow = returnedChars + continuation.length - maxInlineContentChars;
					if (overflow <= 0) break;
					returnedChars -= overflow;
					endOffset = offset + returnedChars;
				}
				const resultSlice = fullResults.slice(offset, endOffset);
				const hasMore = endOffset < fullResults.length;
				const text = `${resultSlice}${hasMore ? continuation : ""}`;
				return {
					content: [{ type: "text", text }],
					details: {
						responseId: params.responseId,
						query: queryData.query,
						resultCount: queryData.results.length,
						contentLength: fullResults.length,
						offset,
						limit,
						returnedChars,
						nextOffset: hasMore ? endOffset : null,
						truncated: hasMore,
					},
				};
			}

			if (data.type === "fetch" && data.urls) {
				let urlData: ExtractedContent | undefined;
				let selectedUrlIndex = -1;

				if (params.url !== undefined) {
					selectedUrlIndex = data.urls.findIndex((u) => u.url === params.url);
					urlData = data.urls[selectedUrlIndex];
					if (!urlData) {
						const available = data.urls.map((u) => u.url).join("\n  ");
						return {
							content: [{ type: "text", text: `URL ${formatInputValue(params.url)} was not found for responseId ${formatInputValue(params.responseId)}. Received url=${formatInputValue(params.url)}. Available URLs:\n  ${available || "  none"}\nUse one of the available URLs or urlIndex.` }],
							details: { error: "URL not found" },
						};
					}
				} else if (params.urlIndex !== undefined) {
					selectedUrlIndex = params.urlIndex;
					urlData = data.urls[selectedUrlIndex];
					if (!urlData) {
						const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
						return {
							content: [{ type: "text", text: `URL index ${formatInputValue(params.urlIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received urlIndex=${formatInputValue(params.urlIndex)}; valid indexes are 0-${data.urls.length - 1}. Available URLs:\n  ${available || "  none"}\nUse one of the available indexes.` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
					return {
						content: [{ type: "text", text: `Specify url or urlIndex for responseId ${formatInputValue(params.responseId)}. Available URLs:\n  ${available || "  none"}` }],
						details: { error: "No URL specified" },
					};
				}

				if (urlData.error) {
					return {
						content: [{ type: "text", text: `Error retrieving URL ${formatInputValue(urlData.url)} from responseId ${formatInputValue(params.responseId)}: ${urlData.error}. Check the stored fetch result and retry with another URL or urlIndex if needed.` }],
						details: { error: urlData.error, url: urlData.url },
					};
				}

				if (params.findText !== undefined) {
					try {
						const found = findContent(urlData.content, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
						const { text, ...findDetails } = found;
						return {
							content: [{ type: "text", text: `# ${urlData.title || urlData.url}\n\n${text}` }],
							details: { url: urlData.url, title: urlData.title, contentLength: urlData.content.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
						};
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in URL ${formatInputValue(urlData.url)} for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
							details: { error, url: urlData.url },
						};
					}
				}

				const offset = params.offset ?? 0;
				const limit = params.limit ?? maxInlineContentChars;
				if (!Number.isInteger(offset) || offset < 0) {
					return {
						content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for URL ${formatInputValue(urlData.url)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
						details: { error: "Invalid offset", offset },
					};
				}
				if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
					return {
						content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for URL ${formatInputValue(urlData.url)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
						details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
					};
				}
				if (offset > urlData.content.length) {
					return {
						content: [{ type: "text", text: `Offset ${offset} is out of range for URL ${formatInputValue(urlData.url)} in responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${urlData.content.length}. Use an offset within that range.` }],
						details: { error: "Offset out of range", offset, contentLength: urlData.content.length },
					};
				}

				const endOffset = Math.min(offset + limit, urlData.content.length);
				const contentSlice = urlData.content.slice(offset, endOffset);
				const hasMore = endOffset < urlData.content.length;
				let text = `# ${urlData.title || urlData.url}\n\n${contentSlice}`;
				if (hasMore || offset > 0) {
					text += `\n\n---\nShowing chars ${offset}-${endOffset} of ${urlData.content.length}.`;
					if (hasMore) {
						text += ` Use ${toolNames.getSearchContent}({ responseId: "${params.responseId}", urlIndex: ${selectedUrlIndex}, offset: ${endOffset}, limit: ${limit} }) for the next slice.`;
					}
				}

				return {
					content: [{ type: "text", text }],
					details: {
						url: urlData.url,
						title: urlData.title,
						contentLength: urlData.content.length,
						offset,
						limit,
						returnedChars: contentSlice.length,
						nextOffset: hasMore ? endOffset : null,
						truncated: hasMore,
					},
				};
			}

			return {
				content: [{ type: "text", text: `Invalid stored data for responseId ${formatInputValue(params.responseId)}: received type ${formatInputValue(data.type)}. Use a responseId returned by ${storedContentSources}.` }],
				details: { error: "Invalid data" },
			};
		},

	});
	}


}
