import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function getWebSearchConfigDir(): string {
  return process.env.PIG_DIR || join(homedir(), ".pig");
}

/**
 * Resolved per call: the host exports PIG_DIR from its own process and may set it after this module
 * was first imported, so a module-level constant would freeze the wrong path.
 */
export function webSearchConfigPath(): string {
	return join(getWebSearchConfigDir(), "web-search.json");
}

/**
 * V8 names the offending token and quotes up to about twenty characters of the file around it, so a
 * raw `JSON.parse` message must never be repeated: `web-search.json` holds API keys, and an
 * unquoted one would be echoed into a tool result. Only the position is safe.
 */
export function parseFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const position = message.match(/at position \d+(?: \(line \d+ column \d+\))?/i);
	return position ? `invalid JSON ${position[0]}` : "invalid JSON";
}

/**
 * Proxy scope shared across module instances. The SDK reloads extensions with moduleCache: false, so a
 * per-instance AsyncLocalStorage would leave the already-installed global fetch wrapper reading the
 * old instance's storage and silently bypassing the proxy configured after a reload.
 */
const PROXY_STORAGE_KEY = Symbol.for("pi-web-access.proxy-storage");

function proxyStorage(): AsyncLocalStorage<string | null> {
	const holder = globalThis as typeof globalThis & { [PROXY_STORAGE_KEY]?: AsyncLocalStorage<string | null> };
	return (holder[PROXY_STORAGE_KEY] ??= new AsyncLocalStorage<string | null>());
}

export function normalizeProxyUrl(value: unknown, source: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error(`${source} must be an http(s) or socks proxy URL string`);
	const trimmed = value.trim();
	if (!trimmed) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`${source} must be a valid proxy URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:" &&
		parsed.protocol !== "socks4:" && parsed.protocol !== "socks4a:" &&
		parsed.protocol !== "socks5:" && parsed.protocol !== "socks5h:") {
		throw new Error(`${source} must use the http://, https://, or socks scheme`);
	}
	if (!parsed.hostname) throw new Error(`${source} must include a proxy host`);
	parsed.hash = "";
	parsed.search = "";
	return parsed.toString();
}

function redactProxyUrl(value: string): string {
	const parsed = new URL(value);
	if (parsed.username) parsed.username = "redacted";
	if (parsed.password) parsed.password = "redacted";
	return parsed.toString();
}

export function loadConfiguredProxy(): string | null {
	let configured: unknown;
	const path = webSearchConfigPath();
	if (existsSync(path)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf-8"));
		} catch (err) {
			throw new Error(`Failed to load proxy config from ${path}: ${parseFailure(err)}`);
		}
		if (raw && typeof raw === "object" && !Array.isArray(raw)) configured = (raw as { proxy?: unknown }).proxy;
	}
	if (configured === undefined) return null;
	return normalizeProxyUrl(configured, `proxy in ${webSearchConfigPath()}`);
}

export function runWithProxy<T>(proxy: string | undefined, fn: () => T): T {
	if (proxy === undefined) {
		const configured = loadConfiguredProxy();
		if (configured === null) return fn();
		installGlobalProxyFetch();
		return proxyStorage().run(configured, fn);
	}
	const normalized = normalizeProxyUrl(proxy, "proxy");
	if (normalized !== null) installGlobalProxyFetch();
	return proxyStorage().run(normalized, fn);
}

export function getActiveProxy(): string | null {
	return proxyStorage().getStore() ?? null;
}

function noProxyEntryMatches(hostname: string, entry: string): boolean {
	if (!entry) return false;
	if (entry === "*") return true;
	let host = entry;
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close > 0) host = host.slice(0, close + 1);
	} else {
		const colon = host.lastIndexOf(":");
		if (colon > -1 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
	}
	host = host.toLowerCase().replace(/^\[|\]$/g, "");
	if (!host) return false;
	return hostname === host || hostname.endsWith(host.startsWith(".") ? host : `.${host}`);
}

/** True when a URL must NOT be sent through the active proxy. */
export function isProxyBypassedUrl(url: URL): boolean {
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1") return true;
	const noProxy = process.env.NO_PROXY || process.env.no_proxy;
	if (noProxy && noProxy.split(",").some((entry) => noProxyEntryMatches(hostname, entry.trim()))) return true;
	return false;
}

export interface ProxiedRequestInit extends RequestInit {
	/** Caller-supplied proxy; bypasses AsyncLocalStorage for pLimit-safe contexts. */
	__proxy?: string;
}

interface ProxiedFetch {
	(input: RequestInfo | URL, init?: ProxiedRequestInit): Promise<Response>;
	__piWebAccessProxyFetch?: boolean;
}

/** Wraps globalThis.fetch so every http(s) call routes through curl while a proxy is active. Idempotent. */
export function installGlobalProxyFetch(): void {
	const current = globalThis.fetch as ProxiedFetch;
	if (typeof current !== "function" || current.__piWebAccessProxyFetch === true) return;
	const nativeFetch = current;
	const wrapped: ProxiedFetch = (async (input: RequestInfo | URL, init?: ProxiedRequestInit) => {
		// Prefer caller-attached __proxy (survives pLimit context loss) over AsyncLocalStorage.
		const proxy = init?.__proxy ?? getActiveProxy();
		if (!proxy) return nativeFetch(input, init);
		let url: URL | null = null;
		try {
			url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		} catch {
			url = null;
		}
		if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || isProxyBypassedUrl(url)) {
			return nativeFetch(input, init);
		}
		if (input instanceof Request || init?.body instanceof FormData) {
			// Request serializes multipart bodies and supplies the matching Content-Type boundary.
			const request = new Request(input, init);
			request.signal.throwIfAborted();
			// Abort body buffering as well as the curl process.
			const body = request.body === null ? null : new Uint8Array(await new Response(
				request.body.pipeThrough(new TransformStream(), { signal: request.signal }),
			).arrayBuffer());
			init = { ...init, method: request.method, headers: request.headers, body, signal: request.signal, redirect: request.redirect };
		}
		return fetchViaCurl(url, init ?? {}, proxy);
	});
	wrapped.__piWebAccessProxyFetch = true;
	globalThis.fetch = wrapped as unknown as typeof fetch;
}

// GET bodies are decoded by --compressed, so their length/encoding headers no longer match.
// HEAD has no body, and its Content-Length is usually why the caller asked.
function parseHeaderDump(dump: string, keepLengthHeaders: boolean): { status: number; statusText: string; headers: Array<[string, string]> } {
	const blocks = dump.split(/\r?\n\r?\n/).filter((block) => /^HTTP\/[\d.]+\s+\d{3}/.test(block.trim()));
	const block = (blocks.length > 0 ? blocks[blocks.length - 1] : "").trim();
	const lines = block.split(/\r?\n/);
	let status = 0;
	let statusText = "";
	const headers: Array<[string, string]> = [];
	for (const line of lines) {
		const match = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/.exec(line.trim());
		if (match) {
			status = Number(match[1]);
			statusText = match[2] ?? "";
			headers.length = 0;
			continue;
		}
		const separator = line.indexOf(":");
		if (separator > 0) {
			const name = line.slice(0, separator).trim();
			if (!keepLengthHeaders && (name.toLowerCase() === "content-encoding" || name.toLowerCase() === "content-length")) continue;
			headers.push([name, line.slice(separator + 1).trim()]);
		}
	}
	return { status, statusText, headers };
}

class CurlTransportError extends Error {
	readonly exitCode: number | null | undefined;

	constructor(message: string, exitCode?: number | null) {
		super(message);
		this.exitCode = exitCode;
	}
}

async function fetchViaCurl(url: URL, init: RequestInit, proxyUrl: string): Promise<Response> {
	let current = url;
	let currentInit = init;
	for (let redirects = 0; ; redirects++) {
		const response = await fetchViaCurlOnce(current, currentInit, proxyUrl);
		const location = response.headers.get("location");
		if (!location || ![301, 302, 303, 307, 308].includes(response.status)) {
			if (redirects > 0) Object.defineProperty(response, "redirected", { value: true, configurable: true });
			return response;
		}
		if (currentInit.redirect === "manual") return response;
		if (currentInit.redirect === "error") throw new TypeError(`Proxy fetch redirect blocked from ${current.toString()}`);
		if (redirects === 20) throw new Error(`Too many proxy redirects from ${url.toString()}`);

		const next = new URL(location, current);
		if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error(`Proxy redirect from ${current.origin} must use HTTP(S)`);

		let headers = new Headers(currentInit.headers);
		let nextInit: RequestInit;
		const method = currentInit.method?.toUpperCase() ?? "GET";
		if (((response.status === 301 || response.status === 302) && method === "POST") || (response.status === 303 && method !== "GET" && method !== "HEAD")) {
			for (const name of ["Content-Encoding", "Content-Language", "Content-Location", "Content-Type"]) headers.delete(name);
			const { body: _body, ...withoutBody } = currentInit;
			nextInit = { ...withoutBody, method: "GET", headers };
		} else {
			nextInit = { ...currentInit, headers };
		}

		if (next.origin !== current.origin) {
			headers = new Headers();
			nextInit = { ...nextInit, headers };
		}
		current = next;
		currentInit = nextInit;
	}
}

async function fetchViaCurlOnce(url: URL, init: RequestInit, proxyUrl: string): Promise<Response> {
	const method = (init.method ?? "GET").toUpperCase();
	const headers = new Headers(init.headers);

	const dir = await mkdtemp(join(tmpdir(), "pi-web-access-proxy-"));
	const headerFile = join(dir, "headers");
	const bodyFile = join(dir, "body");
	const requestBodyFile = join(dir, "request-body");

	const args: string[] = [
		"--silent",
		"--show-error",
		"--compressed",
		"--connect-timeout", "20",
		"--max-filesize", "2097152",
		"-x", proxyUrl,
		"-D", headerFile,
		"--output", bodyFile,
		"--write-out", "%{json}",
	];

	if (method === "HEAD") args.push("--head");
	else if (method !== "GET") args.push("-X", method);

	for (const [name, value] of headers.entries()) {
		if (value === "") continue;
		args.push("-H", `${name}: ${value}`);
	}

	const body = init.body;
	if (body !== undefined && body !== null) {
		let buffer: Buffer;
		if (typeof body === "string") buffer = Buffer.from(body, "utf-8");
		else if (body instanceof URLSearchParams) buffer = Buffer.from(body.toString(), "utf-8");
		else if (body instanceof ArrayBuffer) buffer = Buffer.from(body);
		else if (ArrayBuffer.isView(body)) buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
		else throw new Error(`Unsupported request body type for proxy fetch: ${typeof body}`);
		await writeFile(requestBodyFile, buffer);
		args.push("--data-binary", `@${requestBodyFile}`);
		if (method === "GET") args.unshift("-X", "GET");
	} else if ((method === "POST" || method === "PUT") && !headers.has("content-length")) {
		// Native fetch sends a zero length for a bodyless POST/PUT; some origins answer 411 without it.
		args.push("-H", "Content-Length: 0");
	}

	args.push(url.toString());

	const signal = init.signal ?? null;
	let stdout: string;
	try {
		stdout = await new Promise<string>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new DOMException("The operation was aborted.", "AbortError"));
				return;
			}
			const child = spawn("curl", args, { windowsHide: true });
			let out = "";
			let stderr = "";
			const onAbort = () => { try { child.kill(); } catch {} };
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}
			child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf-8"); });
			child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf-8"); });
			child.once("error", (err: NodeJS.ErrnoException) => {
				signal?.removeEventListener("abort", onAbort);
				reject(new CurlTransportError(err.code === "ENOENT"
					? "curl executable not found on PATH; proxy transport requires curl"
					: `curl failed to start: ${err.message}`));
			});
			child.once("close", (code) => {
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) return reject(new DOMException("The operation was aborted.", "AbortError"));
				if (code !== 0) {
					return reject(new CurlTransportError(`curl exited with code ${code ?? "unknown"} via ${redactProxyUrl(proxyUrl)}${stderr.trim() ? `: ${stderr.trim()}` : ""}`, code));
				}
				resolve(out);
			});
		});
	} catch (err) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw err;
	}

	let bodyBuffer = Buffer.alloc(0);
	let dump = "";
	try {
		[dump, bodyBuffer] = await Promise.all([readFile(headerFile, "utf-8"), readFile(bodyFile)]);
	} catch {
		// HEAD or empty responses may not produce output files.
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}

	const { status, statusText, headers: responseHeaders } = parseHeaderDump(dump, method === "HEAD");
	if (status === 0) {
		throw new Error(`Proxy fetch to ${url.toString()} via ${redactProxyUrl(proxyUrl)} returned no HTTP status`);
	}

	let finalUrl = url.toString();
	let redirected = false;
	try {
		const trimmed = stdout.trim();
		if (trimmed.startsWith("{")) {
			const writeOut = JSON.parse(trimmed) as { url_effective?: string; num_redirects?: number };
			if (writeOut.url_effective) finalUrl = writeOut.url_effective;
			redirected = (writeOut.num_redirects ?? 0) > 0;
		}
	} catch {
		// Older curl without %{json}; the header dump already provided the status.
	}

	const nullBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
	const response = new Response(nullBody ? null : new Uint8Array(bodyBuffer), {
		status,
		statusText: statusText || undefined,
		headers: new Headers(responseHeaders),
	});
	Object.defineProperty(response, "url", { value: finalUrl, configurable: true });
	Object.defineProperty(response, "redirected", { value: redirected, configurable: true });
	return response;
}
