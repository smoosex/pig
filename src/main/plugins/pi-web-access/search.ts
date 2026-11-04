/** Five explicit search adapters. No model calls, key rotation, or provider fallback. */
import { parseHTML } from 'linkedom';
import { providerConnection, readConfig, selectedSearchProvider, type SearchProvider } from './config.ts';
import { record, requestJson, requestText } from './http.ts';

export type SearchSource = {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

function source(item: unknown, excerpt: string): SearchSource {
  const value = record(item);
  if (typeof value.url !== 'string' || typeof value.title !== 'string') throw new Error('Search provider returned an invalid source.');
  let url: URL;
  try { url = new URL(value.url); } catch { throw new Error('Search provider returned an invalid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) throw new Error('Search provider returned an unsafe URL.');
  const rawSnippet = value[excerpt];
  if (rawSnippet !== undefined && typeof rawSnippet !== 'string') throw new Error('Search provider returned an invalid excerpt.');
  const text = parseHTML(`<html><body>${typeof rawSnippet === 'string' ? rawSnippet : ''}</body></html>`).document.body.textContent ?? '';
  return {
    title: value.title.replace(/\s+/g, ' ').trim().slice(0, 300),
    url: url.href,
    snippet: text.replace(/\s+/g, ' ').trim().slice(0, 800),
    ...(typeof value.publishedDate === 'string' ? { publishedAt: value.publishedDate.slice(0, 100) } : {}),
    ...(typeof value.date === 'string' ? { publishedAt: value.date.slice(0, 100) } : {}),
  };
}

function results(data: unknown, excerpt: string): SearchSource[] {
  if (!Array.isArray(data)) throw new Error('Search provider response is missing results.');
  return data.map(item => source(item, excerpt));
}

export function parseDuckDuckGo(html: string): SearchSource[] {
  const { document } = parseHTML(html);
  if (document.querySelector('.anomaly-modal__box, #challenge-form')) throw new Error('DuckDuckGo returned a bot challenge. Choose another search provider in settings.');
  const found: SearchSource[] = [];
  for (const result of document.querySelectorAll('.result')) {
    if (result.classList.contains('result--ad')) continue;
    const anchor = result.querySelector('.result__a');
    const href = anchor?.getAttribute('href');
    if (!href || !anchor) continue;
    const link = new URL(href, 'https://html.duckduckgo.com');
    found.push(source({
      title: anchor.textContent ?? '', url: link.searchParams.get('uddg') ?? link.href,
      snippet: result.querySelector('.result__snippet')?.textContent ?? '',
    }, 'snippet'));
  }
  if (!found.length && !document.querySelector('.no-results__message')) throw new Error('DuckDuckGo returned an unrecognized page, possibly a bot challenge.');
  return found;
}

async function searchOne(provider: SearchProvider, query: string, count: number, config: Record<string, unknown>, signal?: AbortSignal): Promise<SearchSource[]> {
  if (provider === 'duckduckgo') {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);
    const { text } = await requestText(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Pig Web Search)', Accept: 'text/html' } }, { provider: 'DuckDuckGo', signal });
    return parseDuckDuckGo(text).slice(0, count);
  }
  const { baseUrl, apiKey } = providerConnection(provider, config);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  let url = baseUrl;
  let body: Record<string, unknown> | undefined;
  switch (provider) {
    case 'exa':
      url += '/search';
      headers['x-api-key'] = apiKey;
      body = { query, numResults: count, contents: { highlights: true } };
      break;
    case 'deepseek':
      if (Array.from(query).length > 128) throw new Error('DeepSeek search queries must not exceed 128 characters.');
      url += '/search';
      headers.Authorization = `Bearer ${apiKey}`;
      body = { query, count, need_content: false };
      break;
    case 'brave': {
      headers['X-Subscription-Token'] = apiKey;
      const target = new URL(baseUrl.endsWith('/search') ? baseUrl : `${baseUrl}/search`);
      target.searchParams.set('q', query);
      target.searchParams.set('count', String(count));
      url = target.href;
      break;
    }
    case 'tavily':
      url += '/search';
      headers.Authorization = `Bearer ${apiKey}`;
      body = { query, max_results: count, search_depth: 'basic', include_answer: false, include_raw_content: false };
      break;
  }
  const data = record(await requestJson(url, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) }, provider, signal));
  switch (provider) {
    case 'brave': return results(record(data.web).results, 'description').slice(0, count);
    case 'tavily': return results(data.results, 'content').slice(0, count);
    case 'deepseek': return results(data.results, 'summary').map((item, i) => {
      const original = record((data.results as unknown[])[i]);
      return item.snippet ? item : source(original, 'snippet');
    }).slice(0, count);
    case 'exa': {
      if (!Array.isArray(data.results)) throw new Error('Exa response is missing results.');
      return data.results.map(item => {
        const value = record(item);
        if (value.highlights !== undefined && (!Array.isArray(value.highlights) || value.highlights.some(text => typeof text !== 'string'))) throw new Error('Exa returned invalid highlights.');
        return source({ ...value, snippet: Array.isArray(value.highlights) ? value.highlights.join(' ') : '' }, 'snippet');
      }).slice(0, count);
    }
  }
}

export async function searchWeb(queries: string[], count = 10, signal?: AbortSignal, selected?: SearchProvider): Promise<{ provider: SearchProvider; sources: SearchSource[] }> {
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 3 || queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 500)) throw new Error('Provide 1–3 non-empty queries of at most 500 characters.');
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Search result count must be between 1 and 10.');
  const config = readConfig();
  const provider = selected ?? selectedSearchProvider(config);
  // A failed query stops the batch; no hidden retries or provider changes.
  const batches: SearchSource[][] = [];
  for (const query of new Set(queries.map(query => query.trim()))) {
    signal?.throwIfAborted();
    batches.push(await searchOne(provider, query, count, config, signal));
  }
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    for (const batch of batches) {
      const item = batch[i];
      if (item && !seen.has(item.url) && sources.length < count) { seen.add(item.url); sources.push(item); }
    }
  }
  return { provider, sources };
}
