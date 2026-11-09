-- Chat room per fundraiser.
--   * Only signed-in users post (user_id is NOT NULL); anyone can read.
--   * Deletes are soft: the row stays for audit, the API never returns it again.
--   * client_id lets a retried send return the same message instead of posting twice.

CREATE TABLE chat_messages (
  id             uuid PRIMARY KEY,                       -- UUIDv7, so id order is time order
  fundraiser_id  uuid NOT NULL REFERENCES fundraisers(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  client_id      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  deleted_by     uuid REFERENCES users(id)
);
CREATE INDEX chat_room_idx ON chat_messages (fundraiser_id, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX chat_deleted_idx ON chat_messages (fundraiser_id, deleted_at) WHERE deleted_at IS NOT NULL;
-- Live messages only: after a delete, the same client_id may post again as a new message
CREATE UNIQUE INDEX chat_client_idx ON chat_messages (user_id, client_id) WHERE client_id IS NOT NULL AND deleted_at IS NULL;
