-- Engagement analytics: page views from the browser beacon, and meaningful actions
-- (donate, share, follow) written by the server. Bot and internal traffic is kept
-- with a reason and excluded from every metric.
CREATE TABLE analytics_events (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL CHECK (type IN ('page_view','donate','share','follow')),
  visitor_key  text NOT NULL,          -- user id when signed in, else the anonymous browser id
  user_id      uuid,
  target_type  text,
  target_id    uuid,
  path         text,
  bot_reason   text,                   -- null = counted
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_time_idx ON analytics_events (created_at);
CREATE INDEX analytics_visitor_idx ON analytics_events (visitor_key, created_at);

-- Lets the server attribute a settled donation to the browser that made it
ALTER TABLE donations ADD COLUMN visitor_id text;
