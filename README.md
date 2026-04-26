# cf-rag-template

Production RAG pipeline on Cloudflare Workers. ~200 lines of TypeScript. No LangChain, no framework. Deploy in 5 minutes.

> Companion to: [Production RAG on Cloudflare Without LangChain](https://setkernel.com/blog/production-rag-cloudflare-without-langchain)

## What it is

The five primitives of retrieval-augmented generation, mapped to one Cloudflare service each:

| Step | Service | Cost at low volume |
|---|---|---|
| Chunk | Workers (your code) | Free |
| Embed | Workers AI (`@cf/baai/bge-base-en-v1.5`, 768-dim) | Free / trivial |
| Store vectors | Vectorize | $0.04 / 1M vectors / month |
| Store source text | D1 | Free at this scale |
| Generate | Anthropic Claude Sonnet 4.6 (streamed back to client) | $3 / $15 per 1M tokens |

One Worker, three bindings, one external API call. That's it.

## What you get

Three endpoints:

- `POST /ingest` — `{ docId, text }` → chunks, embeds, stores. Returns `{ chunks: N }`.
- `POST /ask` — `{ query }` → SSE stream of Claude's grounded answer with `[1]`, `[2]` citations.
- `POST /forget` — `{ docId }` → removes the document and all its vectors.
- `GET /health` — liveness check.

## Setup (one-time, ~3 minutes)

```bash
# 1. Install
npm install

# 2. Create a D1 database
npx wrangler d1 create rag-db
# Paste the returned database_id into wrangler.jsonc

# 3. Run the migration
npm run db:init:prod

# 4. Create the Vectorize index
npx wrangler vectorize create rag-index --dimensions=768 --metric=cosine

# 5. Set the Anthropic API key as a secret
npx wrangler secret put ANTHROPIC_API_KEY
# (paste your key from https://console.anthropic.com/settings/keys)

# 6. Deploy
npm run deploy
```

The Worker is now live at `https://cf-rag-template.<your-subdomain>.workers.dev`.

## Try it

```bash
WORKER=https://cf-rag-template.<your-subdomain>.workers.dev

# Ingest a document
curl -X POST "$WORKER/ingest" \
  -H 'content-type: application/json' \
  -d '{"docId":"doc-001","text":"The capital of Nova Scotia is Halifax. Founded in 1749, it sits on the second-largest natural harbour in the world."}'
# → {"chunks": 1}

# Ask a question — streams the answer
curl -N -X POST "$WORKER/ask" \
  -H 'content-type: application/json' \
  -d '{"query":"Where is the capital of Nova Scotia?"}'
# → SSE stream with Claude's response, citing [1]

# Forget the document
curl -X POST "$WORKER/forget" \
  -H 'content-type: application/json' \
  -d '{"docId":"doc-001"}'
# → {"removed": 1}
```

## How to extend

- **Better chunking** — replace the naive sliding window in `chunk()` with a corpus-aware splitter (semantic chunking, heading-aware). Single biggest lever on retrieval quality.
- **Different embeddings** — swap `@cf/baai/bge-base-en-v1.5` for `@cf/baai/bge-large-en-v1.5` (slightly better quality) or OpenAI's `text-embedding-3-small` / `-large`. Remember to update `--dimensions` on the Vectorize index.
- **Different model** — `claude-sonnet-4-6` is a sweet spot. For cheaper/faster: `claude-haiku-4-5`. For long context (1M tokens): `claude-opus-4-7`. For routing per task, see the [Workers AI vs OpenAI matrix](https://setkernel.com/blog/workers-ai-vs-openai-cost-quality-matrix).
- **Auth** — the worker is open by default. Add a bearer-token check on the entrypoint before deploying to production.
- **Hybrid retrieval** — pair Vectorize with a lexical-ranker (BM25 in D1) and merge results for higher recall.
- **Eval harness** — write a list of 30–100 known queries with expected answers; run them on every change. Track precision/recall. This is the single most important piece a framework can't give you.

## What this isn't

- Not a framework. Don't use it as a dependency. Fork it, read it, change what you need.
- Not opinionated about the chunking strategy — that's *your* corpus's decision.
- Not auth'd. Add auth before exposing to the internet.

## License

MIT — see [LICENSE](LICENSE).

## Built by

[SetKernel Digital Inc.](https://setkernel.com) — a Cloudflare-native engineering studio. We design, build, and operate AI-augmented products on the edge. Need a production RAG system that actually ships? [Write a brief](https://setkernel.com/contact).
