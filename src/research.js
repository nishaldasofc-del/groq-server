// ---------------------------------------------------------------------------
// Research reports: POST /api/research  { query, depth?: 'standard' | 'deep' }
//
// Pipeline (every model call stays small so it fits the Groq free-tier TPM cap):
//   1. plan      one call -> sub-questions + report outline (JSON)
//   2. search    one web search per sub-question, in parallel
//   3. read      fetch the top page of each sub-question (SSRF-guarded) for real excerpts
//   4. write     one call per section, given ONLY that section's numbered sources
//   5. finalize  executive summary + conclusion from the drafted sections
//   6. assemble  markdown with [n] citations and a references list, streamed as { delta }
//
// SSE events: { research:{stage,...} } progress, { sources, images }, { delta }, { done:true }, { error }
// ---------------------------------------------------------------------------
import dns from 'dns/promises';
import net from 'net';

const MAX_PAGE_BYTES = 400_000;
const PAGE_TIMEOUT_MS = 6000;

const DEPTH = {
  standard: { subq: 5, sections: 4, pages: 5, perSection: 5 },
  deep:     { subq: 7, sections: 6, pages: 8, perSection: 6 }
};

const isoDate = () => new Date().toISOString().slice(0, 10);
const clean = t => String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ---- SSRF guard: only public http(s) hosts ----
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}
async function assertPublicUrl(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error('bad protocol');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('private host');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('private address');
  return url;
}

// ---- Fetch a page and boil it down to readable text ----
async function fetchPageText(startUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    let url = await assertPublicUrl(startUrl);
    let r;
    for (let hop = 0; hop < 3; hop++) {
      r = await fetch(url, {
        redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SunsetAI-Research/1.0)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' }
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = await assertPublicUrl(new URL(r.headers.get('location'), url).href); continue; }
      break;
    }
    if (!r || !r.ok) throw new Error(`HTTP ${r?.status}`);
    const type = r.headers.get('content-type') || '';
    if (!/text\/(html|plain)|xhtml/i.test(type)) throw new Error('not text');
    const reader = r.body.getReader();
    const chunks = []; let size = 0;
    while (size < MAX_PAGE_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
    }
    try { reader.cancel(); } catch {}
    let html = Buffer.concat(chunks).toString('utf8');
    html = html
      .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const lines = html.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l.length > 70);
    return lines.join('\n').slice(0, 3500);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Search (Tavily-compatible endpoint) ----
async function searchRaw(query, cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
    const r = await fetch(cfg.url, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ query, max_results: 5, include_answer: false, include_images: true, include_image_descriptions: true, search_depth: cfg.depth })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    return { results: Array.isArray(raw.results) ? raw.results : [], images: Array.isArray(raw.images) ? raw.images : [] };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(text) {
  const t = String(text || '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const fixCites = t => String(t || '').replace(/【(\d{1,2})(?:[†:][^】]*)?】/g, '[$1]').replace(/[【】]/g, '');

let running = 0;

export function registerResearch(app, d) {
  app.post('/api/research', async (req, res) => {
    const query = String(req.body?.query || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!query) return res.status(400).json({ success: false, error: "Missing 'query'." });
    if (!process.env.GROQ_API_KEY) return res.status(401).json({ success: false, error: 'GROQ_API_KEY environment variable is not set.' });
    if (!d.search.url) return res.status(503).json({ success: false, error: 'Web search is not configured (SEARCH_URL).' });
    if (running >= (Number(process.env.MAX_CONCURRENT_RESEARCH) || 2)) return res.status(429).json({ success: false, error: 'Research is busy. Try again in a minute.' });

    const cfg = DEPTH[req.body?.depth === 'deep' ? 'deep' : 'standard'];
    const model = process.env.MODEL_RESEARCH || d.MODES.balanced.model;
    const fallbacks = d.MODES.balanced.fallback;

    running++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    let aborted = false;
    const hb = setInterval(() => { if (!aborted) res.write(': ping\n\n'); }, 15000);
    res.on('close', () => { aborted = true; clearInterval(hb); });
    const send = obj => { if (!aborted) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    const progress = (stage, extra = {}) => send({ research: { stage, ...extra } });
    const guard = () => { if (aborted) throw Object.assign(new Error('aborted'), { aborted: true }); };

    // One model call; on a 429 wait for the provider's window instead of failing
    async function ask(system, user, maxTokens) {
      for (let attempt = 0; attempt < 4; attempt++) {
        guard();
        try {
          const c = await d.createWithRetry({
            model, temperature: 0.4, max_tokens: maxTokens,
            reasoning_effort: 'low', include_reasoning: false,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
          }, fallbacks);
          return fixCites(c.choices?.[0]?.message?.content || '').trim();
        } catch (e) {
          if (e.status === 429 && attempt < 3) {
            const wait = Math.min(d.retryAfterMs(e), 20000) + 300;
            progress('wait', { detail: `Rate limit reached, resuming in ${Math.ceil(wait / 1000)}s` });
            await d.sleep(wait);
            continue;
          }
          throw e;
        }
      }
      return '';
    }

    try {
      // ── 1. PLAN ───────────────────────────────────────────────────────
      progress('plan', { detail: 'Planning the research' });
      const planRaw = await ask(
        `You plan research reports. Today is ${isoDate()}. Reply with ONLY a JSON object, no prose:\n` +
        `{"title":"short report title","subquestions":[{"q":"question to answer","query":"web search query, max 10 words"}],"sections":[{"heading":"section heading","goal":"what this section must establish","uses":[0,1]}]}\n` +
        `Rules: 3-${cfg.subq} subquestions; ${Math.max(3, cfg.sections - 1)}-${cfg.sections} sections in a logical order (for example background, current state, key facts and data, comparison, risks, outlook). "uses" lists 0-based subquestion indexes and every section uses at least one. Do NOT add Introduction, Summary or Conclusion sections. Search queries must be specific and self-contained.`,
        `Research topic: ${query}`, 900);
      let plan = parseJsonLoose(planRaw);
      let subs = Array.isArray(plan?.subquestions) ? plan.subquestions.filter(s => s && (s.query || s.q)).slice(0, cfg.subq) : [];
      let secs = Array.isArray(plan?.sections) ? plan.sections.filter(s => s && s.heading).slice(0, cfg.sections) : [];
      if (subs.length < 2 || secs.length < 2) { // fallback plan
        subs = [{ q: query, query: query.slice(0, 120) }, { q: `Key facts and recent developments: ${query}`, query: `${query} latest` }, { q: `Risks, criticism and outlook: ${query}`, query: `${query} risks outlook` }].slice(0, 3);
        secs = [{ heading: 'Background', goal: 'Explain the topic and context', uses: [0] }, { heading: 'Key findings', goal: 'Present the most important facts and data', uses: [0, 1] }, { heading: 'Risks and outlook', goal: 'Cover challenges, disagreements and what comes next', uses: [1, 2] }];
        plan = { title: query.slice(0, 80) };
      }
      const title = String(plan?.title || query).replace(/[#*\n]/g, ' ').trim().slice(0, 120);
      progress('plan_done', { title, sections: secs.map(s => String(s.heading).slice(0, 80)), questions: subs.map(s => String(s.q || s.query).slice(0, 120)) });

      // ── 2. SEARCH (parallel) ──────────────────────────────────────────
      guard();
      let searched = 0;
      progress('search', { done: 0, total: subs.length, detail: 'Searching the web' });
      const found = await Promise.all(subs.map(async s => {
        const out = await searchRaw(String(s.query || s.q).slice(0, 200), d.search).catch(e => ({ results: [], images: [], error: e.message }));
        progress('search', { done: ++searched, total: subs.length, detail: String(s.query || s.q).slice(0, 80) });
        return out;
      }));

      // Global source registry, numbered in sub-question order: [n] in the text == position in the sources list
      const registry = new Map(); // url -> source
      const subSources = subs.map(() => []);
      found.forEach((f, i) => {
        f.results.slice(0, 4).forEach(x => {
          const url = x?.url; if (!url || !/^https?:\/\//i.test(url)) return;
          let src = registry.get(url);
          if (!src) {
            src = { n: registry.size + 1, title: clean(x.title).slice(0, 140) || new URL(url).hostname, url, snippet: clean(x.content || x.snippet).slice(0, 900), page: '' };
            registry.set(url, src);
          }
          if (!subSources[i].includes(src)) subSources[i].push(src);
        });
      });
      if (registry.size === 0) throw new Error('Web search returned nothing, so I could not research this. Please try again in a moment.');

      const seenImg = new Set();
      const images = found.flatMap(f => f.images).map(im => typeof im === 'string' ? { url: im } : { url: im?.url, alt: im?.description })
        .filter(im => /^https:\/\//i.test(im.url || '') && !seenImg.has(im.url) && seenImg.add(im.url)).slice(0, 6)
        .map(im => ({ url: im.url, alt: String(im.alt || title).slice(0, 200) }));
      const sourceList = [...registry.values()];
      send({ sources: sourceList.map(({ title, url, snippet }) => ({ title, url, snippet: snippet.slice(0, 180) })), images });

      // ── 3. READ the top page of each sub-question ─────────────────────
      guard();
      const toRead = [];
      subSources.forEach(list => { const s = list.find(x => !x.page && !toRead.includes(x)); if (s) toRead.push(s); });
      const readList = toRead.slice(0, cfg.pages);
      let read = 0;
      progress('read', { done: 0, total: readList.length, detail: 'Reading sources' });
      await Promise.all(readList.map(async s => {
        try { s.page = await fetchPageText(s.url); } catch { /* snippet is still available */ }
        progress('read', { done: ++read, total: readList.length, detail: new URL(s.url).hostname.replace(/^www\./, '') });
      }));

      // ── 4. WRITE section by section ───────────────────────────────────
      const excerpt = s => `${s.snippet}${s.page ? '\n' + s.page : ''}`.slice(0, Number(process.env.RESEARCH_SOURCE_CHARS) || 1100);
      const writerSystem =
        `You are a careful research analyst writing ONE section of a research report. Today is ${isoDate()}.\n` +
        `- Use ONLY the numbered sources provided. Cite every factual claim with its source number in plain ASCII brackets like [2], or [1][3] for several. Never use any other bracket style.\n` +
        `- Never invent facts, numbers, quotes, names or URLs. If sources disagree, say so. If the sources do not cover part of the goal, say that briefly instead of guessing.\n` +
        `- Write 180-320 words of clear, specific prose (dates, figures, names where the sources give them). At most one short bullet list or one Markdown table, only when it genuinely helps.\n` +
        `- Output only the section body: no heading, no preamble, no report-level conclusion.`;
      const drafts = [];
      for (let i = 0; i < secs.length; i++) {
        guard();
        const sec = secs[i];
        const uses = (Array.isArray(sec.uses) && sec.uses.length ? sec.uses : [i % subs.length]).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < subs.length);
        const pool = [];
        (uses.length ? uses : [0]).forEach(u => subSources[u].forEach(s => { if (!pool.includes(s)) pool.push(s); }));
        if (pool.length === 0) sourceList.slice(0, cfg.perSection).forEach(s => pool.push(s));
        const chosen = pool.slice(0, cfg.perSection);
        progress('write', { done: i, total: secs.length, detail: String(sec.heading).slice(0, 80) });
        let body = '';
        try {
          body = await ask(writerSystem,
            `Report topic: ${query}\nSection: ${sec.heading}\nGoal: ${sec.goal || sec.heading}\n\nSOURCES:\n` +
            chosen.map(s => `[${s.n}] ${s.title} (${new URL(s.url).hostname})\n${excerpt(s)}`).join('\n\n'), 1500);
        } catch (e) { if (e.aborted) throw e; console.error('Research section failed:', e.message); }
        body = body.replace(/^\s*#{1,6}[^\n]*\n+/, '').trim();
        drafts.push({ heading: String(sec.heading).replace(/[#*\n]/g, ' ').trim().slice(0, 100), body: body || '_This section could not be generated. Try running the research again._' });
        progress('write', { done: i + 1, total: secs.length, detail: String(sec.heading).slice(0, 80) });
      }

      // ── 5. FINALIZE: summary + conclusion ─────────────────────────────
      guard();
      progress('finalize', { detail: 'Writing summary and conclusion' });
      let summary = '', conclusion = '';
      try {
        const out = await ask(
          `You finish a research report. From the section drafts, write the executive summary and the conclusion. Keep the [n] citations from the drafts; do not add new facts. Output exactly this format:\nSUMMARY:\n<110-170 words, key findings first>\nCONCLUSION:\n<80-140 words: what it means, limits or open questions of the evidence, and 2-3 concrete next steps>`,
          `Topic: ${query}\n\n` + drafts.map(x => `## ${x.heading}\n${x.body.slice(0, 1300)}`).join('\n\n'), 1100);
        const m = /SUMMARY:\s*([\s\S]*?)\s*CONCLUSION:\s*([\s\S]*)$/i.exec(out);
        if (m) { summary = m[1].trim(); conclusion = m[2].trim(); } else summary = out.replace(/^SUMMARY:\s*/i, '').trim();
      } catch (e) { if (e.aborted) throw e; console.error('Research summary failed:', e.message); }

      // ── 6. ASSEMBLE ───────────────────────────────────────────────────
      const body = drafts.map(x => `## ${x.heading}\n\n${x.body}`).join('\n\n');
      const cited = new Set([...(`${summary}\n${body}\n${conclusion}`).matchAll(/\[(\d{1,2})\]/g)].map(m => Number(m[1])));
      const refs = sourceList.filter(s => cited.has(s.n)).map(s => `- **${s.n}.** [${s.title.replace(/[\[\]]/g, '')}](${s.url}) (${new URL(s.url).hostname.replace(/^www\./, '')})`);
      const md =
        `# ${title}\n\n` +
        `*Research report · ${isoDate()} · ${cited.size || sourceList.length} sources*\n\n` +
        (summary ? `## Executive summary\n\n${summary}\n\n` : '') +
        `${body}\n\n` +
        (conclusion ? `## Conclusion and next steps\n\n${conclusion}\n\n` : '') +
        (refs.length ? `## References\n\n${refs.join('\n')}\n` : '');

      progress('finalize_done', { words: md.split(/\s+/).length });
      for (let i = 0; i < md.length; i += 240) { guard(); send({ delta: md.slice(i, i + 240) }); }
      send({ done: true, mode: 'research', research: { stage: 'done', sources: sourceList.length } });
      res.write('data: [DONE]\n\n');
    } catch (e) {
      if (!e.aborted) {
        console.error('Research error:', e.message || e);
        send({ error: e.message || 'Research failed.' });
        if (!aborted) res.write('data: [DONE]\n\n');
      }
    } finally {
      running--;
      clearInterval(hb);
      if (!aborted) res.end();
    }
  });
}
