/**
 * Production RAG on Cloudflare Workers — no LangChain, no framework.
 *
 * Endpoints:
 *   POST /ingest    body: { docId, text }    → chunks, embeds, stores
 *   POST /ask       body: { query }           → streams Claude's answer (SSE)
 *   POST /forget    body: { docId }           → removes a doc + its vectors
 *   GET  /health                              → liveness
 *
 * See the companion essay:
 *   https://setkernel.com/blog/production-rag-cloudflare-without-langchain
 */

import type { Ai, D1Database, VectorizeIndex } from '@cloudflare/workers-types';

interface Env {
  AI: Ai;
  VEC: VectorizeIndex;
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
}

// ─── 1. Chunk ────────────────────────────────────────────────────────────────
// Naive sliding-window chunker. Replace with a corpus-aware chunker (split on
// headings, keep tables together) when retrieval quality matters more than
// implementation simplicity.
function chunk(text: string, size = 800, overlap = 100): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

// ─── 2. Embed ────────────────────────────────────────────────────────────────
// BGE base = 768 dims, free at low volume on Workers AI, ~18 ms in-Worker.
async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const res = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: texts });
  return res.data;
}

// ─── 3. Store ────────────────────────────────────────────────────────────────
async function ingest(env: Env, docId: string, text: string): Promise<{ chunks: number }> {
  const chunks = chunk(text);
  if (chunks.length === 0) return { chunks: 0 };

  const vectors = await embed(env, chunks);

  // Source-of-truth chunks in D1.
  const stmt = env.DB.prepare('INSERT OR REPLACE INTO chunks (id, doc_id, text) VALUES (?, ?, ?)');
  await env.DB.batch(chunks.map((c, i) => stmt.bind(`${docId}#${i}`, docId, c)));

  // Vectors + minimal metadata in Vectorize.
  await env.VEC.upsert(
    chunks.map((_, i) => ({
      id: `${docId}#${i}`,
      values: vectors[i],
      metadata: { docId, idx: i },
    })),
  );

  return { chunks: chunks.length };
}

// ─── 4. Retrieve ─────────────────────────────────────────────────────────────
interface Hit { id: string; score: number; text: string }

async function retrieve(env: Env, query: string, topK = 5): Promise<Hit[]> {
  const [q] = await embed(env, [query]);
  const result = await env.VEC.query(q, { topK, returnMetadata: 'all' });

  const ids = result.matches.map(m => m.id);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, text FROM chunks WHERE id IN (${placeholders})`,
  ).bind(...ids).all<{ id: string; text: string }>();

  const byId = new Map(rows.results.map(r => [r.id, r.text]));
  return result.matches.map(m => ({
    id: m.id,
    score: m.score,
    text: byId.get(m.id) ?? '',
  }));
}

// ─── 5. Prompt + stream ──────────────────────────────────────────────────────
async function answer(env: Env, query: string): Promise<Response> {
  const hits = await retrieve(env, query);

  if (hits.length === 0) {
    return new Response(
      'data: {"type":"text","text":"No indexed documents match this query."}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }

  const context = hits
    .map((h, i) => `[${i + 1}] (score=${h.score.toFixed(3)})\n${h.text}`)
    .join('\n\n');

  const sys = `You answer using ONLY the numbered context below. If the answer is not present, say so. Cite sources as [1], [2], etc.\n\n${context}`;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: sys,
      messages: [{ role: 'user', content: query }],
      stream: true,
    }),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

// ─── 6. Forget ───────────────────────────────────────────────────────────────
async function forget(env: Env, docId: string): Promise<{ removed: number }> {
  const rows = await env.DB.prepare('SELECT id FROM chunks WHERE doc_id = ?')
    .bind(docId).all<{ id: string }>();
  const ids = rows.results.map(r => r.id);
  if (ids.length > 0) {
    await env.VEC.deleteByIds(ids);
    await env.DB.prepare('DELETE FROM chunks WHERE doc_id = ?').bind(docId).run();
  }
  return { removed: ids.length };
}

// ─── Worker entrypoint ───────────────────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, ts: Date.now() });
    }

    if (req.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    try {
      if (url.pathname === '/ingest') {
        const { docId, text } = await req.json<{ docId: string; text: string }>();
        if (!docId || !text) return Response.json({ error: 'docId and text required' }, { status: 400 });
        const out = await ingest(env, docId, text);
        return Response.json(out);
      }

      if (url.pathname === '/ask') {
        const { query } = await req.json<{ query: string }>();
        if (!query) return Response.json({ error: 'query required' }, { status: 400 });
        return answer(env, query);
      }

      if (url.pathname === '/forget') {
        const { docId } = await req.json<{ docId: string }>();
        if (!docId) return Response.json({ error: 'docId required' }, { status: 400 });
        const out = await forget(env, docId);
        return Response.json(out);
      }

      return new Response('not found', { status: 404 });
    } catch (err) {
      console.error('rag error', err);
      return Response.json({ error: 'internal error', detail: String(err) }, { status: 500 });
    }
  },
};
