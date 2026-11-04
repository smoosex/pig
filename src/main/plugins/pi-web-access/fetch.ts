/** Plain page retrieval only; dynamic/authenticated pages belong to Pig's browser tools. */
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { providerConnection, readConfig, selectedSearchProvider } from './config.ts';
import { requestJson, requestText, WebRequestError } from './http.ts';
import { loadFetchContentDomainPolicy, validateRemoteUrl } from './transport.ts';

type RemoteFetchProvider = 'deepseek' | 'exa' | 'tavily';
export interface WebPage {
  url: string;
  title: string;
  content: string;
  retrieval?: { provider: RemoteFetchProvider | 'http'; fallbackFrom?: RemoteFetchProvider; reason?: string };
}

export function htmlToMarkdown(html: string, url: string): { title: string; content: string } {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll('script, style, noscript, template, iframe, object, embed, [hidden], [aria-hidden="true"]')) node.remove();
  for (const node of document.querySelectorAll('[href], [src]')) {
    for (const attr of ['href', 'src']) {
      const value = node.getAttribute(attr);
      if (value) {
        try {
          const absolute = new URL(value, url);
          if (['https:', 'http:'].includes(absolute.protocol)) node.setAttribute(attr, absolute.href);
          else node.removeAttribute(attr);
        } catch { node.removeAttribute(attr); }
      }
    }
  }
  const title = document.title.slice(0, 300);
  const fallback = document.body?.innerHTML || document.toString();
  const article = new Readability(document as unknown as Document).parse();
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  return { title: article?.title?.slice(0, 300) || title, content: turndown.turndown(article?.content || fallback).trim() };
}

export async function fetchPage(input: string, signal?: AbortSignal): Promise<WebPage> {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Provide an absolute HTTP(S) URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || input.length > 16_384) throw new Error('Provide an HTTP(S) URL without embedded credentials, at most 16384 characters.');
  signal?.throwIfAborted();
  const config = readConfig();
  const provider = selectedSearchProvider(config);
  if (provider === 'deepseek' || provider === 'exa' || provider === 'tavily') {
    // Enforce target policy before disclosing its URL to any hosted fetch service.
    validateRemoteUrl(url, loadFetchContentDomainPolicy());
    signal?.throwIfAborted();
    // Resolve credentials outside the fallback: bad configuration must remain visible.
    const connection = providerConnection(provider, config);
    try {
      return await fetchRemotePage(url, provider, connection, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof WebRequestError)) throw error;
      try {
        const page = await fetchHttpPage(url, signal);
        return { ...page, retrieval: { provider: 'http', fallbackFrom: provider, reason: error.message } };
      } catch (localError) {
        signal?.throwIfAborted();
        throw new Error(`${provider} Fetch failed: ${error.message} Local HTTP fallback failed: ${localError instanceof Error ? localError.message : 'Unknown error'}`);
      }
    }
  }
  return fetchHttpPage(url, signal);
}

async function fetchRemotePage(url: URL, provider: RemoteFetchProvider, { baseUrl, apiKey }: { baseUrl: string; apiKey: string }, signal?: AbortSignal): Promise<WebPage> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let path: string;
  let body: Record<string, unknown>;
  if (provider === 'exa') {
    path = '/contents';
    headers['x-api-key'] = apiKey;
    body = { ids: [url.href], text: true };
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
    path = provider === 'deepseek' ? '/fetch' : '/extract';
    body = provider === 'deepseek' ? { url: url.href } : { urls: [url.href], format: 'markdown' };
  }
  const raw = await requestJson(baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body) }, `${provider} Fetch`, signal);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WebRequestError(`${provider} Fetch returned an invalid response.`);
  const data = raw as Record<string, unknown>;
  const result = provider === 'deepseek' ? data : Array.isArray(data.results) ? data.results[0] : undefined;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new WebRequestError(`${provider} Fetch returned no page.`);
  const page = result as Record<string, unknown>;
  const content = page[provider === 'exa' ? 'text' : provider === 'tavily' ? 'raw_content' : 'content'];
  if (typeof content !== 'string' || !content.trim()) throw new WebRequestError(`${provider} Fetch returned no usable Markdown.`);
  if (content.length > 1_000_000) throw new WebRequestError(`${provider} Fetch exceeds the 1,000,000-character storage limit.`);
  return { url: url.href, title: typeof page.title === 'string' ? page.title.slice(0, 300) : '', content, retrieval: { provider } };
}

async function fetchHttpPage(url: URL, signal?: AbortSignal): Promise<WebPage> {
  const { text, response, url: finalUrl } = await requestText(url, { headers: { Accept: 'text/html,text/plain,application/json,application/xml;q=0.9', 'User-Agent': 'Pig Web Access' } }, { signal });
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  let page: WebPage;
  if (mime === 'text/html' || mime === 'application/xhtml+xml') page = { url: finalUrl, ...htmlToMarkdown(text, finalUrl) };
  else if (mime.startsWith('text/') || ['application/json', 'application/xml'].includes(mime) || mime.endsWith('+json') || mime.endsWith('+xml')) page = { url: finalUrl, title: '', content: text };
  else throw new Error('Unsupported content type. web_fetch reads HTML and text only; use browser or file tools for other formats.');
  if (!page.content.trim()) throw new WebRequestError('Web page returned no usable text.');
  return { ...page, retrieval: { provider: 'http' } };
}
