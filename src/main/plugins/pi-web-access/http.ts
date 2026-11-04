/** Bounded transport over the configured proxy and HTTP domain/redirect policy. */
import { fetchRemoteUrl, loadFetchContentDomainPolicy, WebPolicyError } from './transport.ts';
import { runWithProxy } from './utils.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Remote request/response failures permit a credential-free local HTTP fallback. */
export class WebRequestError extends Error {}

export async function readResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new WebRequestError('Web response exceeds the 2 MiB limit; request a more specific URL.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function requestText(url: string | URL, init: RequestInit, options: { provider?: string; signal?: AbortSignal } = {}): Promise<{ text: string; response: Response; url: string }> {
  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  return runWithProxy(undefined, async () => {
    const domainPolicy = options.provider ? undefined : loadFetchContentDomainPolicy();
    let response: Response;
    let finalUrl = String(url);
    const checkAbort = () => {
      if (options.signal?.aborted) throw new Error('Web request cancelled.');
      if (timeout.aborted) throw new WebRequestError('Web request timed out after 30 seconds.');
    };
    try {
      response = await fetchRemoteUrl(url, { ...init, signal }, {
        maxRedirects: options.provider ? 0 : 5,
        onRedirect: ({ to, init }) => { finalUrl = to.href; return init; },
        domainPolicy,
      });
    } catch (error) {
      checkAbort();
      if (error instanceof WebPolicyError) throw error;
      if (error instanceof Error && error.cause instanceof WebPolicyError) throw error.cause;
      // Transport exceptions can contain proxy credentials; never expose their raw text.
      throw new WebRequestError('Web request failed; check your network and proxy.');
    }
    if (!response.ok || response.status === 202) {
      await response.body?.cancel();
      if (response.status === 403) throw new WebPolicyError(`${options.provider ?? 'Web page'} refused the request (HTTP 403).`);
      throw new WebRequestError(`${options.provider ?? 'Web page'} returned HTTP ${response.status}${response.status === 202 ? ' (possible bot challenge)' : ''}.`);
    }
    try {
      return { text: await readResponse(response), response, url: finalUrl };
    } catch (error) {
      checkAbort();
      if (error instanceof WebRequestError) throw error;
      throw new WebRequestError('Could not read the web response.');
    }
  });
}

export async function requestJson(url: string | URL, init: RequestInit, provider: string, signal?: AbortSignal): Promise<unknown> {
  const { text } = await requestText(url, init, { provider, signal });
  try {
    return JSON.parse(text);
  } catch {
    throw new WebRequestError(`${provider} returned invalid JSON.`);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Search provider returned an invalid response.');
  return value as Record<string, unknown>;
}
