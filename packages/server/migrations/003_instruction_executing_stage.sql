-- Durable marker written BEFORE the model call: a retry that finds 'executing' knows the outcome is uncertain and never calls the model again.
ALTER TABLE claude_instructions DROP CONSTRAINT claude_instructions_stage_check;
ALTER TABLE claude_instructions
  ADD CONSTRAINT claude_instructions_stage_check CHECK (stage IN ('claimed','callout_written','executing','executed','published'));
