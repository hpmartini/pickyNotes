-- Follow-up proposals from the curator (tasks, appointments, issues). They are only ever proposals: nothing in the system acts on them.
-- The vault keeps the original list in the note's frontmatter; the status lives only here (a reindex does not restore suggestions).
CREATE TABLE suggestions (
  id         text PRIMARY KEY,
  note_id    text NOT NULL,
  title      text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, title)
);
CREATE INDEX suggestions_status_idx ON suggestions (status, created_at);
