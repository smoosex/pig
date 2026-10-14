// Pi host for the web tools. Tool behavior lives in web-tool-core.ts; this file only
// registers the tools, wires session state, and renders nothing (Pig draws tool output
// in its own UI, so there is no pi-tui surface here).
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtractedContent } from "./extract.ts";
import { clearCloneCache, releaseClonesUnusedSince, touchClones } from "./github-extract.ts";
import { ALL_SEARCH_PROVIDERS, getAllowedSearchProviders, providerLabel, RESOLVED_SEARCH_PROVIDERS, type ResolvedSearchProvider } from "./gemini-search.ts";
export type { ProviderAvailability } from "./gemini-search.ts";
import {
	generateId,
	holdResults,
	loadSessionResults,
	releaseResults,
	storeFetchedContentResult,
	type StoredSearchData,
} from "./storage.ts";
import { activityMonitor } from "./activity.ts";
import { answerFromPage } from "./page-query.ts";
import { parseStringifiedArrays } from "./tool-arguments.ts";
import { runWithProxy } from "./utils.ts";
import {
	createWebToolCore,
	DEFAULT_TOOL_NAMES,
	fetchAllContent,
	fetchUncoveredContent,
	getMaxInlineContentChars,
	isToolEnabled,
	loadConfig,
	markToolError,
	resolveFetchModeConfig,
	storedContentSourceNames,
	stripThumbnails,
	webSearchConfigPath,
	withRegisteredFetchOptions,
	type FetchedContentData,
	type FetchMode,
	type ToolNames,
	type WebSearchConfig,
} from "./web-tool-core.ts";

// Match pi-ai's StringEnum without loading its compat barrel during registration.
function StringEnum<T extends string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

// structuredContent shapes that codemode scripts receive (web-tool-contract.ts),
// on success and on isError results.
const nullableString = (description: string) => Type.Union([Type.String(), Type.Null()], { description });
const webSearchOutputSchema = Type.Object({
	responseId: Type.String({ description: "Id of the stored search results" }),
	fetchId: nullableString("Stored page content id when includeContent fetched or started fetching content, else null"),
	queries: Type.Array(Type.Object({
		query: Type.String(),
		answer: Type.String({ description: "Provider answer text, empty when the provider returned only results" }),
		error: nullableString("Why this query failed, null on success"),
		provider: Type.Optional(Type.String()),
		providers: Type.Optional(Type.Array(Type.String())),
		results: Type.Array(Type.Object({ title: Type.String(), url: Type.String(), snippet: Type.String() })),
	})),
});
const fetchContentOutputSchema = Type.Object({
	responseId: nullableString("Id of the stored content, null when nothing was stored"),
	urls: Type.Array(Type.Object({
		url: Type.String(),
		title: Type.String(),
		content: Type.String({ description: "Full extracted content, not limited by the inline character cap" }),
		error: nullableString("Why this URL failed, null on success"),
		mimeType: Type.Optional(Type.String()),
		status: Type.Optional(Type.Number()),
		duration: Type.Optional(Type.Number()),
	})),
});

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FETCH_MODE_DESCRIPTIONS: Record<FetchMode, string> = {
	readable: "extract readable content as markdown",
	raw: "return the exact textual body using direct HTTP only",
	answer: "answer a prompt using only fetched content",
};

function searchProviderSchema(description: string, allowedProviders: readonly ResolvedSearchProvider[]) {
	return Type.Union([
		StringEnum(["auto", "all", ...allowedProviders]),
		Type.Array(StringEnum([...allowedProviders]), { minItems: 1 }),
	], { description });
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

/** Extension instances with a live session, and when that session started. A host may run
 * several at once (one instance per session); clones are removed outright only when none
 * remains, and otherwise once no live session can have been given their paths. */
const liveInstances = new Map<object, number>();

export default function (pi: ExtensionAPI) {
	const initConfig = loadConfigForExtensionInit();
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
	const resolvedFetchModes = resolveFetchModeConfig(initConfig);
	const coreSettings = {
		toolNames,
		enabledTools: {
			webSearch: webSearchEnabled,
			sourceCheck: sourceCheckEnabled,
			fetchContent: fetchContentEnabled,
			getSearchContent: getSearchContentEnabled,
		},
		maxInlineContentChars: getMaxInlineContentChars(initConfig),
		fetchModes: resolvedFetchModes,
	};

	// Names as registered this session, so fetch failure guidance never points
	// at tools that are disabled or were renamed after init.
	const registeredToolNames = {
		...(webSearchEnabled ? { webSearch: toolNames.webSearch } : {}),
		...(fetchContentEnabled ? { fetchContent: toolNames.fetchContent } : {}),
		...(getSearchContentEnabled ? { getSearchContent: toolNames.getSearchContent } : {}),
	};
	const storedContentSources = storedContentSourceNames(coreSettings);
	const searchQueryDescription = webSearchEnabled
		? `Get content for this query (${toolNames.webSearch})`
		: "Get content for a stored search query";
	const fetchContentStorageNote = getSearchContentEnabled
		? `Full original content is stored for retrieval with ${toolNames.getSearchContent}.`
		: "Full original content is stored internally, but the retrieval tool is not registered.";
	const fetchModeDescription = resolvedFetchModes.allowedModes
		.map(mode => `${mode}${mode === resolvedFetchModes.defaultMode ? " (default)" : ""}: ${FETCH_MODE_DESCRIPTIONS[mode]}`)
		.join("; ");

	// Session state is this instance's. A host that serves several sessions at once runs one
	// instance per session, and one session starting or ending must not clear another's results.
	const instance = {};
	const pendingFetches = new Map<string, AbortController>();
	let sessionActive = false;
	/** Ids of the results this instance's session holds in memory. */
	const ownedResults = new Set<string>();

	function abortPendingFetches(): void {
		for (const controller of pendingFetches.values()) {
			controller.abort();
		}
		pendingFetches.clear();
	}

	function own(id: string): void {
		if (ownedResults.has(id)) return;
		ownedResults.add(id);
		holdResults([id]);
	}

	function publish(data: StoredSearchData): void {
		own(data.id);
		pi.appendEntry("web-search-results", data);
	}

	function endSession(): void {
		sessionActive = false;
		abortPendingFetches();
		releaseResults(ownedResults);
		ownedResults.clear();
		liveInstances.delete(instance);
		if (liveInstances.size === 0) clearCloneCache();
		else releaseClonesUnusedSince(Math.min(...liveInstances.values()));
	}

	function startSession(ctx: ExtensionContext): void {
		endSession();
		liveInstances.set(instance, Date.now());
		sessionActive = true;
		const restored = loadSessionResults(ctx);
		for (const data of restored) own(data.id);
		// Restored results may point at clone paths; they are in use for as long as this session is.
		touchClones(restored.flatMap((data) => (data.type === "fetch" ? (data.urls ?? data.urlMetadata ?? []).map((u) => u.url) : [])));
		activityMonitor.clear();
	}

	function startBackgroundFetch(urls: string[], proxy?: string, provided?: ExtractedContent[]): string | null {
		if (urls.length === 0) return null;
		const fetchId = generateId();
		const controller = new AbortController();
		pendingFetches.set(fetchId, controller);
		Promise.resolve()
			.then(() => fetchUncoveredContent(urls, provided, missing => runWithProxy(proxy, () => fetchAllContent(missing, controller.signal, withRegisteredFetchOptions(undefined, registeredToolNames, proxy)))))
			.then((fetched) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const data = {
					id: fetchId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetched),
				} satisfies FetchedContentData;
				publish(storeFetchedContentResult(fetchId, data));
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

	const core = createWebToolCore({
		settings: coreSettings,
		storeFetchedContent(id, data) {
			publish(storeFetchedContentResult(id, data));
		},
		publishResult(data) {
			publish(data);
		},
		startBackgroundFetch,
		answerFromPage: (request, ctx, signal) => answerFromPage(request, ctx!, signal),
	});

	// web_search calls a tool made, such as a codemode script, reach the tool_call
	// handlers before execute with parentToolCallId set; execute consumes the id.
	// Ids of calls a later handler blocked are dropped when the session changes.
	const nestedSearchCallIds = new Set<string>();
	if (webSearchEnabled) pi.on("tool_call", (event) => {
		if (event.parentToolCallId && event.toolName === toolNames.webSearch) nestedSearchCallIds.add(event.toolCallId);
	});

	pi.on("session_start", async (_event, ctx) => { nestedSearchCallIds.clear(); startSession(ctx); });
	pi.on("session_tree", async (_event, ctx) => { nestedSearchCallIds.clear(); startSession(ctx); });

	pi.on("session_shutdown", () => {
		nestedSearchCallIds.clear();
		endSession();
		activityMonitor.clear();
	});

	if (webSearchEnabled) pi.registerTool({
		name: toolNames.webSearch,
		label: "Web Search",
		prepareArguments: (args) => parseStringifiedArrays(args, ["provider", "queries", "domainFilter"]) as never,
		description:
			`Search the web and return source-linked results or provider answers.${getSearchContentEnabled ? ` Full results are stored for retrieval with ${toolNames.getSearchContent} using the returned responseId.` : ""} For research, prefer queries with 2-4 varied angles over a single query. Omit provider to use the configured default; set it only to override that.`,
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
			category: Type.Optional(Type.String({ description: "Exa only: result category, e.g. news, research paper" })),
			provider: Type.Optional(searchProviderSchema(`Search provider or non-empty list of allowed providers to search simultaneously; ${allPolicyDescription}; omit this field to use the configured provider, or use auto when none is configured`, allowedSearchProviders)),
			proxy: Type.Optional(Type.String({
				description: "http(s) or socks proxy URL (e.g. http://host:port or socks5h://host:port) used for every outbound request in this call (search APIs and content fetches). Node fetch ignores HTTP(S)_PROXY env vars, so set this (or `proxy` in web-search.json) when direct access is blocked; empty string forces direct access.",
			})),
		}),
		outputSchema: webSearchOutputSchema,

		async execute(callId, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
			// Nested calls (a codemode script calling this tool) wait for includeContent
			// pages instead of fetching them in the background, so the script gets content.
			const nested = nestedSearchCallIds.delete(callId);
			return markToolError(await core.webSearch(params, signal, {
				extensionContext: ctx,
				onUpdate,
				awaitContent: nested,
			}));
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
			return markToolError(await core.sourceCheck(params, signal, { extensionContext: ctx }));
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
				description: resolvedFetchModes.allowedModes.includes("answer")
					? "Question or instruction for video analysis, or the page-local question required by answer mode."
					: "Question or instruction for video analysis.",
			})),
			mode: Type.Optional(StringEnum(resolvedFetchModes.allowedModes, {
				description: `Fetch mode. ${fetchModeDescription}.`,
			})),
			...(resolvedFetchModes.allowedModes.includes("answer") ? {
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
			redirects: Type.Optional(StringEnum(["same-origin"], {
				description: "Refuse cross-origin redirects: every redirect target must match the requested URL's scheme, hostname and effective port, and extraction paths whose redirect chain cannot be observed are refused instead of used.",
			})),
		}),
		outputSchema: fetchContentOutputSchema,

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
			return markToolError(await core.fetchContent(params, signal, { extensionContext: ctx, onUpdate }));
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
				return markToolError(await core.getSearchContent(rawParams));
			},
		});
	}
}
