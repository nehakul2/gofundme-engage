-- Core schema. Mirrors the architecture doc, with the product decisions applied:
--   * USD is the only currency (CHECK constraints)
--   * No private communities (no communities.visibility column)
--   * donations.last_verified_at supports the 24 h / 48 h provider verification job
-- Money is integer cents. IDs are app-generated UUIDv7.

CREATE EXTENSION IF NOT EXISTS citext;

-- Identity and profile -------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  handle        citext UNIQUE NOT NULL,
  display_name  text NOT NULL,
  bio           text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Old handles and slugs keep redirecting after a rename
CREATE TABLE slug_history (
  kind        text NOT NULL CHECK (kind IN ('user','fundraiser','community')),
  old_slug    citext NOT NULL,
  entity_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, old_slug)
);

-- Fundraisers ----------------------------------------------------------
CREATE TABLE fundraisers (
  id               uuid PRIMARY KEY,
  owner_id         uuid NOT NULL REFERENCES users(id),
  slug             citext UNIQUE NOT NULL,
  title            text NOT NULL,
  story            text NOT NULL,                 -- sanitized on write
  cover_image_url  text,
  goal_cents       bigint NOT NULL CHECK (goal_cents > 0),
  currency         char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','active','ended','removed')),
  ends_at          timestamptz,
  goal_reached_at  timestamptz,                   -- set once, atomically
  version          integer NOT NULL DEFAULT 1,    -- optimistic concurrency
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fundraisers_owner_idx ON fundraisers (owner_id, created_at DESC);

-- Derived aggregate, written only by the counter worker in batches.
-- donor_count counts succeeded donations (supporters), not distinct people.
CREATE TABLE fundraiser_stats (
  fundraiser_id   uuid PRIMARY KEY REFERENCES fundraisers(id),
  raised_cents    bigint NOT NULL DEFAULT 0,
  donor_count     integer NOT NULL DEFAULT 0,
  share_count     integer NOT NULL DEFAULT 0,
  follower_count  integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Donation ledger (source of truth) ------------------------------------
CREATE TABLE donations (
  id                uuid PRIMARY KEY,
  fundraiser_id     uuid NOT NULL REFERENCES fundraisers(id),
  donor_id          uuid REFERENCES users(id),     -- null = guest
  donor_name        text,                          -- optional name a guest typed
  is_anonymous      boolean NOT NULL DEFAULT false,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  currency          char(3) NOT NULL CHECK (currency = 'USD'),
  message           text,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','succeeded','failed','refunded')),
  provider_ref      text UNIQUE,                   -- dedupes webhook replays
  idempotency_key   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  succeeded_at      timestamptz,
  last_verified_at  timestamptz,                   -- set by the 24 h verification job
  UNIQUE (idempotency_key)
);
-- Recent-donor feed and pagination; tiebreak on id
CREATE INDEX donations_feed_idx
  ON donations (fundraiser_id, succeeded_at DESC, id DESC)
  WHERE status = 'succeeded';
CREATE INDEX donations_donor_idx ON donations (donor_id, created_at DESC);
-- Finds pending donations that are due for provider verification
CREATE INDEX donations_pending_idx ON donations (created_at) WHERE status = 'pending';

-- Communities ----------------------------------------------------------
CREATE TABLE communities (
  id           uuid PRIMARY KEY,
  slug         citext UNIQUE NOT NULL,
  name         text NOT NULL,
  description  text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE community_members (
  community_id uuid NOT NULL REFERENCES communities(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('member','moderator','owner')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);
CREATE INDEX community_members_user_idx ON community_members (user_id);
CREATE TABLE community_fundraisers (
  community_id  uuid NOT NULL REFERENCES communities(id),
  fundraiser_id uuid NOT NULL REFERENCES fundraisers(id),
  added_by      uuid NOT NULL REFERENCES users(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, fundraiser_id)
);
CREATE INDEX community_fundraisers_fr_idx ON community_fundraisers (fundraiser_id);
CREATE TABLE posts (
  id            uuid PRIMARY KEY,
  community_id  uuid NOT NULL REFERENCES communities(id),
  author_id     uuid NOT NULL REFERENCES users(id),
  body          text NOT NULL,                     -- sanitized on write
  status        text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_feed_idx ON posts (community_id, created_at DESC, id DESC)
  WHERE status = 'visible';

-- Engagement -----------------------------------------------------------
-- The composite key makes follow and unfollow idempotent.
CREATE TABLE follows (
  follower_id  uuid NOT NULL REFERENCES users(id),
  target_type  text NOT NULL CHECK (target_type IN ('user','fundraiser','community')),
  target_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, target_type, target_id)
);
CREATE INDEX follows_target_idx ON follows (target_type, target_id);

-- dedupe_key = hash(actor or anon id, fundraiser, channel, day)
CREATE TABLE shares (
  id             uuid PRIMARY KEY,
  fundraiser_id  uuid NOT NULL REFERENCES fundraisers(id),
  user_id        uuid REFERENCES users(id),
  channel        text NOT NULL,
  dedupe_key     text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Reliability plumbing -------------------------------------------------
CREATE TABLE idempotency_keys (
  key           text PRIMARY KEY,
  request_hash  text NOT NULL,
  response      jsonb,
  status_code   integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Written in the same transaction as the change it describes
CREATE TABLE outbox_events (
  id              bigserial PRIMARY KEY,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  event_type      text NOT NULL,   -- donation.succeeded, milestone.reached, ...
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;
