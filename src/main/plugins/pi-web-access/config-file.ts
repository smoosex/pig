/**
 * One reader for the plugin's `web-search.json`.
 *
 * Every provider used to carry its own copy of "read the file, parse it, remember the result", so a
 * caching rule could only be changed in forty files at once, and forty files had drifted into three
 * different rules. There is one rule now: the parsed document is remembered per file signature —
 * path, mtime and size — so a host that re-points PIG_DIR after the plugin was imported, and any edit
 * to the file, both take effect on the next read. Pig's settings save also reloads the extension
 * (`src/main/ipc/plugins.ts`), and this does not replace that; it just stops freshness from depending
 * on the caller remembering.
 *
 * An absent file reads as `{}` rather than a provider-specific default: callers normalize missing
 * fields themselves, and a fallback here would hide the difference between "no config at all" and
 * "config that lacks one section".
 *
 * Both failures keep the `Failed to parse ` prefix, because the extract paths classify config errors
 * with it (`isConfigParseError` in extract.ts, pdf-extract.ts, video-extract.ts, gemini-url-context.ts
 * and others), and neither quotes the parser's own message: `JSON.parse` echoes up to about twenty
 * characters of source text around the failure, and this file holds API keys, so a key pasted without
 * quotes would otherwise be handed straight into a tool result.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { parseFailure, webSearchConfigPath } from "./utils.ts";

export function createConfigFileReader<T extends object>(): () => T {
	let cachedSignature: string | null = null;
	let cached: T | null = null;

	return () => {
		const path = webSearchConfigPath();
		const signature = signatureOf(path);
		if (cachedSignature !== signature) {
			cachedSignature = signature;
			cached = null;
		}
		if (cached) return cached;

		if (!existsSync(path)) {
			const empty = {} as T;
			cached = empty;
			return empty;
		}

		const raw = readFileSync(path, "utf-8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error(`Failed to parse ${path}: ${parseFailure(error)}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Failed to parse ${path}: expected a JSON object`);
		}
		cached = parsed as T;
		return cached;
	};
}

/**
 * A missing file keeps the bare path as its signature, so creating one later still invalidates the
 * cached `{}`. Any other stat failure propagates instead: swallowing it would report "no config" and
 * stop the signature from changing, so the reader would stay wrong for as long as the failure lasts.
 */
function signatureOf(path: string): string {
	let stat;
	try {
		stat = statSync(path);
	} catch (error) {
		if (isMissing(error)) return path;
		throw error;
	}
	return `${path}:${stat.mtimeMs}:${stat.size}`;
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}
