-- Source-of-truth chunk storage. Vectorize stores only vectors + metadata;
-- the actual chunk text lives here so we can hydrate retrieval results.
CREATE TABLE IF NOT EXISTS chunks (
  id     TEXT PRIMARY KEY,           -- "{docId}#{chunkIndex}", matches Vectorize ID
  doc_id TEXT NOT NULL,
  text   TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
