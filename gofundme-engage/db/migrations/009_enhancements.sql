-- Enhancements: organizer updates, cover photos, and notification attribution.
--   * fundraiser_updates   posts written by the organizer; followers and donors are notified
--   * posts / notifications accept the new 'update' kind
--   * fundraiser_covers    one cover image per fundraiser, stored in Postgres (see README, tradeoffs)
--   * analytics_events.source   marks page views that came from a notification, so the admin page
--                               can show how many repeat visits the bell brings back

CREATE TABLE fundraiser_updates (
  id             uuid PRIMARY KEY,                        -- UUIDv7, so id order is time order
  fundraiser_id  uuid NOT NULL REFERENCES fundraisers(id),
  author_id      uuid NOT NULL REFERENCES users(id),
  body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  client_id      text,                                    -- a retried post returns the same update
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fundraiser_updates_feed_idx ON fundraiser_updates (fundraiser_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX fundraiser_updates_client_idx ON fundraiser_updates (author_id, client_id) WHERE client_id IS NOT NULL;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN ('milestone', 'update'));

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_kind_check;
ALTER TABLE posts ADD CONSTRAINT posts_kind_check CHECK (kind IN ('member', 'milestone', 'update'));
ALTER TABLE posts ADD COLUMN update_id uuid REFERENCES fundraiser_updates(id);
-- An update appears once per community, even if the event is delivered twice
CREATE UNIQUE INDEX posts_update_once ON posts (community_id, update_id) WHERE update_id IS NOT NULL;

CREATE TABLE fundraiser_covers (
  fundraiser_id  uuid PRIMARY KEY REFERENCES fundraisers(id),
  content_type   text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data           bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 2097152),   -- 2 MB
  version        integer NOT NULL DEFAULT 1,              -- changes the image URL, so caches never serve a stale cover
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE analytics_events ADD COLUMN source text CHECK (source IN ('notification'));
