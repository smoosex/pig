/** Signature-cached configuration with lazy PIG_DIR resolution and credential-safe parse errors. */
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
