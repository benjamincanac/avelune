import { createMCPClient } from '@ai-sdk/mcp'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { nativeFetch } from './nativeFetch'

/**
 * The Coach's documentation sources: every Vercel framework and primitive.
 * Two kinds. Remote MCP servers are used as-is (tools prefixed per server so names never
 * collide). Sites without an MCP are reached through `search_docs` / `read_docs_page` over
 * their public llms.txt index and Markdown page endpoints.
 * Vercel MCP itself (mcp.vercel.com) is OAuth-only, so the platform docs ride vercel.com's
 * Markdown sitemap instead.
 */

interface McpSource {
  id: string
  url: string
  about: string
}

export const MCP_SOURCES: McpSource[] = [
  { id: 'nuxt', url: 'https://nuxt.com/mcp', about: 'Nuxt framework docs, modules, deploy guides, blog, changelog' },
  { id: 'nuxt_ui', url: 'https://ui.nuxt.com/mcp', about: 'Nuxt UI components, composables, templates, icons' },
  { id: 'svelte', url: 'https://mcp.svelte.dev/mcp', about: 'Svelte and SvelteKit' },
  { id: 'docus', url: 'https://docus.dev/mcp', about: 'Docus documentation theme' },
  { id: 'comark', url: 'https://comark.dev/mcp', about: 'Comark, components in Markdown' },
]

interface DocsSite {
  index: string
  about: string
  /** Appending `.md` to a page url returns its Markdown. */
  markdownPages: boolean
}

export const DOCS_SITES: Record<string, DocsSite> = {
  vercel: { index: 'https://vercel.com/docs/sitemap.md', about: 'Vercel platform: deployments, Functions, Fluid compute, WebSockets, AI Gateway, Sandbox, Blob, Edge Network, domains, CLI, REST API, MCP, plans and pricing', markdownPages: true },
  nextjs: { index: 'https://nextjs.org/docs/llms.txt', about: 'Next.js', markdownPages: true },
  turborepo: { index: 'https://turborepo.com/llms.txt', about: 'Turborepo', markdownPages: true },
  ai_sdk: { index: 'https://ai-sdk.dev/llms.txt', about: 'AI SDK (ai, @ai-sdk/*, agents, providers, AI Gateway usage)', markdownPages: true },
  chat_sdk: { index: 'https://chat-sdk.dev/llms.txt', about: 'Chat SDK: bots for Slack, Teams, Discord, Telegram, WhatsApp', markdownPages: true },
  flags_sdk: { index: 'https://flags-sdk.dev/llms.txt', about: 'Flags SDK: feature flags', markdownPages: false },
  workflow: { index: 'https://useworkflow.dev/llms.txt', about: 'Workflow DevKit: durable workflows', markdownPages: false },
  v0: { index: 'https://v0.app/docs/llms.txt', about: 'v0: AI app builder', markdownPages: false },
}

const SITE_IDS = Object.keys(DOCS_SITES) as [string, ...string[]]

/** Hosts `read_docs_page` may fetch: our docs sites and the MCP servers' sites. */
const READABLE_HOSTS = new Set([
  'vercel.com', 'nextjs.org', 'turborepo.com', 'ai-sdk.dev', 'chat-sdk.dev', 'flags-sdk.dev', 'useworkflow.dev', 'v0.app',
  'nuxt.com', 'ui.nuxt.com', 'content.nuxt.com', 'image.nuxt.com', 'svelte.dev', 'docus.dev', 'comark.dev',
])

const FETCH_TIMEOUT = 15_000
const INDEX_TTL = 6 * 60 * 60 * 1000
/** Full-text llms dumps run to 1+ MB; anything past this is dropped. */
const MAX_INDEX_BYTES = 3_000_000
const MAX_PAGE_CHARS = 8_000
const MAX_RESULTS = 8
const SNIPPET_CHARS = 360

async function fetchText(url: string, max: number): Promise<string> {
  const res = await nativeFetch(url, {
    headers: { 'user-agent': 'VercelStadiumCoach/1.0', 'accept': 'text/markdown, text/plain, text/html;q=0.5' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
  return (await res.text()).slice(0, max)
}

/* -------------------------------------------------------------------------- */
/* search_docs: keyword search over a site's llms.txt / sitemap               */
/* -------------------------------------------------------------------------- */

interface Chunk {
  title: string
  url?: string
  text: string
}

/** `- [Title](url): summary` (llms.txt) or `- [Title](/path) | Type: … | Summary: …` (vercel.com sitemap). */
const LINK_LINE = /^-\s*\[([^\]]+)\]\(([^)\s]+)\)\s*[:|]?\s*(.*)$/

/**
 * Two llms.txt dialects. Index files list one link line per page, one chunk each.
 * Full-text dumps concatenate pages behind `---\ntitle:` frontmatter, one chunk per page.
 */
function chunkIndex(text: string, base: string): Chunk[] {
  if (/^---\s*\ntitle:/m.test(text)) {
    return text.split(/\n(?=---\s*\ntitle:)/).map((page) => {
      const title = /^title:\s*(.+)$/m.exec(page)?.[1]?.trim() ?? 'Untitled'
      const body = page.replace(/^---[\s\S]*?\n---\s*\n/, '')
      return { title, text: body }
    })
  }
  const chunks: Chunk[] = []
  for (const line of text.split('\n')) {
    const m = LINK_LINE.exec(line.trim())
    if (m) chunks.push({ title: m[1]!, url: new URL(m[2]!, base).href.replace(/\?from=llms-txt$/, ''), text: m[3] ?? '' })
  }
  return chunks
}

const indexCache = new Map<string, { at: number, chunks: Chunk[] }>()

async function siteChunks(site: string): Promise<Chunk[]> {
  const cached = indexCache.get(site)
  if (cached && Date.now() - cached.at < INDEX_TTL) return cached.chunks
  const index = DOCS_SITES[site]!.index
  const chunks = chunkIndex(await fetchText(index, MAX_INDEX_BYTES), index)
  indexCache.set(site, { at: Date.now(), chunks })
  return chunks
}

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9@/._-]{3,}/g) ?? [])]
}

function countHits(haystack: string, term: string): number {
  let n = 0
  let i = haystack.indexOf(term)
  while (i !== -1 && n < 5) {
    n++
    i = haystack.indexOf(term, i + term.length)
  }
  return n
}

/** A window of the text around its first hit, or the start when nothing matched. */
function snippet(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  const hit = words.map(w => lower.indexOf(w)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, hit - SNIPPET_CHARS / 3)
  const cut = flat.slice(start, start + SNIPPET_CHARS)
  return `${start ? '…' : ''}${cut}${start + SNIPPET_CHARS < flat.length ? '…' : ''}`
}

async function searchSite(site: string, query: string): Promise<string> {
  const words = terms(query)
  if (!words.length) return 'Query too short.'
  const scored = (await siteChunks(site))
    .map((c) => {
      const title = c.title.toLowerCase()
      const text = c.text.toLowerCase()
      const score = words.reduce((s, w) => s + countHits(title, w) * 4 + countHits(text, w), 0)
      return { c, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
  if (!scored.length) return `No match for "${query}" in the ${site} docs index.`
  return scored
    .map(({ c }) => `## ${c.title}${c.url ? `\n${c.url}` : ''}\n${snippet(c.text, words)}`)
    .join('\n\n')
}

/** ai-sdk.dev ships a real search endpoint; prefer it over the tiny llms.txt index. */
async function searchAiSdk(query: string): Promise<string> {
  const raw = await fetchText(`https://ai-sdk.dev/api/search-docs?q=${encodeURIComponent(query)}`, 200_000)
  const { results } = JSON.parse(raw) as { results: { url: string, title: string, description?: string }[] }
  if (!results?.length) return `No match for "${query}" in the AI SDK docs.`
  return results.slice(0, MAX_RESULTS).map(r => `## ${r.title}\n${r.url}\n${r.description ?? ''}`).join('\n\n')
}

/* -------------------------------------------------------------------------- */
/* read_docs_page: one page as Markdown                                       */
/* -------------------------------------------------------------------------- */

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

async function readPage(input: string): Promise<string> {
  const url = new URL(input)
  if (!READABLE_HOSTS.has(url.hostname)) return `Refusing to fetch ${url.hostname}: not a Vercel documentation site.`
  url.hash = ''
  url.search = ''
  // Prefer the Markdown twin; fall back to the page itself when the site has none.
  const wantsMarkdown = !/\.(md|txt|json)$/.test(url.pathname)
  const candidates = wantsMarkdown ? [`${url.href.replace(/\/$/, '')}.md`, url.href] : [url.href]
  let lastError = ''
  for (const candidate of candidates) {
    try {
      const text = await fetchText(candidate, MAX_PAGE_CHARS * 4)
      const body = /^\s*<(!doctype|html)/i.test(text) ? stripHtml(text) : text
      return `${candidate}\n\n${body.slice(0, MAX_PAGE_CHARS)}${body.length > MAX_PAGE_CHARS ? '\n…(truncated)' : ''}`
    }
    catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return `Could not read ${url.href}: ${lastError}`
}

/* -------------------------------------------------------------------------- */
/* Tool set                                                                   */
/* -------------------------------------------------------------------------- */

const siteTools: ToolSet = {
  search_docs: tool({
    description: `Search the documentation index of a Vercel product that has no MCP server. Call this FIRST for any question about these products, then read_docs_page for the best hit. Sites: ${Object.entries(DOCS_SITES).map(([id, s]) => `${id} = ${s.about}`).join('; ')}.`,
    inputSchema: z.object({
      site: z.enum(SITE_IDS).describe('Which product documentation to search.'),
      query: z.string().min(3).describe('Keywords, e.g. "websocket max duration" or "streamText tool calling".'),
    }),
    execute: async ({ site, query }) => (site === 'ai_sdk' ? searchAiSdk(query) : searchSite(site, query)),
  }),
  read_docs_page: tool({
    description: 'Read one documentation page (as Markdown) from any Vercel documentation site: vercel.com, nextjs.org, turborepo.com, ai-sdk.dev, chat-sdk.dev, flags-sdk.dev, useworkflow.dev, v0.app, nuxt.com and its modules, svelte.dev, docus.dev, comark.dev. Use the url returned by a search.',
    inputSchema: z.object({ url: z.string().url() }),
    execute: async ({ url }) => readPage(url),
  }),
}

const MCP_CONNECT_TIMEOUT = 12_000
/** After a partial connect, try the missing servers again on the next question. */
const MCP_RETRY_AFTER = 60_000

let mcpTools: ToolSet = {}
const mcpConnected = new Set<string>()
let mcpLastAttempt = 0
let mcpConnecting: Promise<void> | null = null

async function connectOne(src: McpSource): Promise<ToolSet> {
  const client = await Promise.race([
    createMCPClient({
      transport: { type: 'http', url: src.url, fetch: nativeFetch },
      clientName: 'vercel-stadium-coach',
      onUncaughtError: error => console.log('[coach] mcp', src.id, error instanceof Error ? error.message : error),
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('connect timeout')), MCP_CONNECT_TIMEOUT)),
  ])
  const tools = await client.tools()
  // Prefix per server: two servers both expose `get-page`. The tool keeps calling its own name.
  // Cast: McpToolSet's `Tool<unknown>` entries don't structurally satisfy the ToolSet union.
  return Object.fromEntries(Object.entries(tools).map(([name, t]) => {
    t.description = `[${src.about}] ${t.description ?? ''}`.trim()
    return [`${src.id}__${name}`, t]
  })) as ToolSet
}

async function connectMissing(): Promise<void> {
  mcpLastAttempt = Date.now()
  const missing = MCP_SOURCES.filter(s => !mcpConnected.has(s.id))
  const results = await Promise.allSettled(missing.map(connectOne))
  results.forEach((r, i) => {
    const src = missing[i]!
    if (r.status === 'fulfilled') {
      mcpTools = { ...mcpTools, ...r.value }
      mcpConnected.add(src.id)
      console.log('[coach] mcp connected', src.id, Object.keys(r.value).length, 'tools')
    }
    else {
      console.log('[coach] mcp failed', src.id, r.reason instanceof Error ? r.reason.message : r.reason)
    }
  })
}

/**
 * Every docs tool the Coach can call. MCP servers connect lazily on the first
 * question and stay connected; servers that failed are retried on later questions.
 */
export async function docsTools(): Promise<ToolSet> {
  const incomplete = mcpConnected.size < MCP_SOURCES.length
  if (incomplete && !mcpConnecting && Date.now() - mcpLastAttempt > MCP_RETRY_AFTER) {
    mcpConnecting = connectMissing().finally(() => {
      mcpConnecting = null
    })
  }
  if (mcpConnecting) await mcpConnecting
  return { ...siteTools, ...mcpTools }
}
