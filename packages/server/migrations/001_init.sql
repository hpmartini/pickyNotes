CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The vault is the source of truth: this table is a rebuildable index (see POST /admin/reindex).
CREATE TABLE notes (
  id           text PRIMARY KEY,
  path         text NOT NULL UNIQUE,
  title        text NOT NULL,
  body         text NOT NULL,
  tags         text[] NOT NULL DEFAULT '{}',
  summary      text,
  source       text NOT NULL CHECK (source IN ('typed','dictated','imported')),
  status       text NOT NULL CHECK (status IN ('pending','curated','failed')),
  content_hash text,
  embedding    vector(384),
  created_at   timestamptz NOT NULL DEFAULT now(),
  fts          tsvector GENERATED ALWAYS AS (to_tsvector('german', title || ' ' || body)) STORED,
  trgm_text    text GENERATED ALWAYS AS (title || ' ' || left(body, 5000)) STORED
);
CREATE INDEX notes_fts_idx ON notes USING gin (fts);
CREATE INDEX notes_trgm_idx ON notes USING gin (trgm_text gin_trgm_ops);
CREATE INDEX notes_embedding_idx ON notes USING hnsw (embedding vector_cosine_ops);

CREATE TABLE devices (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhooks (
  id     text PRIMARY KEY,
  url    text NOT NULL,
  secret text NOT NULL
);

CREATE TABLE llm_usage (
  day   date PRIMARY KEY,
  count integer NOT NULL DEFAULT 0
);

-- Exactly-once for @claude: the same instruction text in the same note can be claimed only once.
CREATE TABLE claude_instructions (
  id               text PRIMARY KEY,
  note_id          text NOT NULL,
  instruction_hash text NOT NULL,
  status           text NOT NULL,
  UNIQUE (note_id, instruction_hash)
);

CREATE TABLE conflicts (
  id     serial PRIMARY KEY,
  path   text NOT NULL,
  kind   text NOT NULL,
  detail text,
  at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (path, kind)
);
