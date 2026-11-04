/** HTTP(S) transport with domain/redirect policy; DNS and proxy routing belong to the network stack. */
import { isIP } from 'node:net';
import { readConfig } from './config.ts';
import { installGlobalProxyFetch, type ProxiedRequestInit } from './utils.ts';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Policy refusals must not be retried through another transport. */
export class WebPolicyError extends Error {}

export interface DomainPolicy {
  allow: string[];
  deny: string[];
}

function hostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function domainEntries(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('fetchContent.domainPolicy entries must be arrays of hostnames.');
  return value.map(entry => {
    if (typeof entry !== 'string') throw new Error('fetchContent.domainPolicy entries must be hostnames.');
    const normalized = hostname(entry.trim());
    if (!normalized || normalized.length > 253 || (!isIP(normalized) && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized))) {
      throw new Error('fetchContent.domainPolicy contains an invalid hostname.');
    }
    return normalized;
  });
}

export function loadFetchContentDomainPolicy(): DomainPolicy {
  const config = readConfig().fetchContent;
  if (config === undefined || config === null) return { allow: [], deny: [] };
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error('fetchContent must be an object.');
  const policy = (config as Record<string, unknown>).domainPolicy;
  if (policy === undefined || policy === null) return { allow: [], deny: [] };
  if (typeof policy !== 'object' || Array.isArray(policy)) throw new Error('fetchContent.domainPolicy must be an object.');
  const { allow, deny } = policy as Record<string, unknown>;
  return { allow: domainEntries(allow), deny: domainEntries(deny) };
}

export function validateRemoteUrl(input: string | URL, policy?: DomainPolicy): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new WebPolicyError('Provide an HTTP(S) URL without embedded credentials.');
  }
  const host = hostname(url.hostname);
  const matches = (entry: string) => host === entry || host.endsWith(`.${entry}`);
  if (policy?.deny.some(matches)) throw new WebPolicyError(`Blocked hostname by fetch_content domain policy: ${host}`);
  if (policy?.allow.length && !policy.allow.some(matches)) throw new WebPolicyError(`Hostname not allowed by fetch_content domain policy: ${host}`);
  return url;
}

export async function fetchRemoteUrl(input: string | URL, init: ProxiedRequestInit = {}, options: {
  domainPolicy?: DomainPolicy;
  maxRedirects?: number;
  onRedirect?: (args: { from: URL; to: URL; init: RequestInit; response: Response }) => RequestInit;
  fetch?: typeof fetch;
} = {}): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  let current = validateRemoteUrl(input, options.domainPolicy);
  const origin = current.origin;
  let requestInit = init;
  if (init.__proxy) installGlobalProxyFetch();
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    requestInit.signal?.throwIfAborted();
    const response = await (options.fetch ?? fetch)(current, { ...requestInit, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    await response.body?.cancel();
    if (redirects === maxRedirects) throw new WebPolicyError('Too many redirects.');
    const next = validateRemoteUrl(new URL(location, current), options.domainPolicy);
    if (next.origin !== origin) throw new WebPolicyError('Refused cross-origin redirect by web page redirect policy.');
    const from = current;
    current = next;
    if (response.status === 303 || ([301, 302].includes(response.status) && requestInit.method?.toUpperCase() === 'POST')) {
      const { body: _body, ...rest } = requestInit;
      requestInit = { ...rest, method: 'GET' };
    }
    if (options.onRedirect) requestInit = options.onRedirect({ from, to: current, init: requestInit, response });
  }
  throw new WebPolicyError('Too many redirects.');
}
