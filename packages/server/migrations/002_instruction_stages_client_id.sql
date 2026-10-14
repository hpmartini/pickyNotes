-- Staged @claude instructions: a retry resumes after the last completed stage and reuses the stored result.
ALTER TABLE claude_instructions
  ADD COLUMN stage  text NOT NULL DEFAULT 'claimed' CHECK (stage IN ('claimed','callout_written','executed','published')),
  ADD COLUMN result text;
UPDATE claude_instructions SET stage = 'published' WHERE status IN ('done','failed');

-- Idempotent captures: a retried capture with the same client id resolves to the existing note (NULLs stay distinct).
ALTER TABLE notes ADD COLUMN client_id text UNIQUE;
