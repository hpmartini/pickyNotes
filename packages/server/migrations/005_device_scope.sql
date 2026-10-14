-- 'capture' tokens may only submit captures (e.g. the mail forwarder); 'full' is the existing behaviour.
ALTER TABLE devices ADD COLUMN scope text NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'capture'));
