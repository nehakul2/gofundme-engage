-- Chat moderation beyond removal by the author or organizer.
--   chat_reports   a signed-in user flags a message; an admin reviews it
--   user_mutes     one person hides another person's messages for themselves only
--   blocked_words  words that may not appear in chat messages (managed by an admin)
CREATE TABLE chat_reports (
  id          uuid PRIMARY KEY,
  message_id  uuid NOT NULL REFERENCES chat_messages(id),
  reporter_id uuid NOT NULL REFERENCES users(id),
  reason      text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'removed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  handled_at  timestamptz,
  UNIQUE (message_id, reporter_id)                  -- reporting twice changes nothing
);
CREATE INDEX chat_reports_open_idx ON chat_reports (created_at) WHERE status = 'open';

CREATE TABLE user_mutes (
  user_id    uuid NOT NULL REFERENCES users(id),
  muted_id   uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, muted_id),
  CHECK (user_id <> muted_id)
);

CREATE TABLE blocked_words (
  word     citext PRIMARY KEY CHECK (char_length(word) BETWEEN 2 AND 40),
  added_at timestamptz NOT NULL DEFAULT now()
);
