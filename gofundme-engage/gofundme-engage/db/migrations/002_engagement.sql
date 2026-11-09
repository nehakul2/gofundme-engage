-- Engagement features: milestone moments, notifications, "since you last visited".

-- One row per fundraiser and threshold. The primary key is the "fires once" guard:
-- only the insert that creates the row goes on to emit the milestone.
-- Rows are never deleted, so a refund cannot make a milestone fire twice.
CREATE TABLE fundraiser_milestones (
  fundraiser_id  uuid NOT NULL REFERENCES fundraisers(id),
  threshold_pct  smallint NOT NULL CHECK (threshold_pct IN (25,50,75,100)),
  raised_cents   bigint NOT NULL,      -- total when it was reached
  donor_count    integer NOT NULL,
  reached_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fundraiser_id, threshold_pct)
);

-- System-generated posts share the community feed with member posts.
-- A milestone post is authored by the fundraiser's owner.
ALTER TABLE posts
  ADD COLUMN kind          text NOT NULL DEFAULT 'member' CHECK (kind IN ('member','milestone')),
  ADD COLUMN fundraiser_id uuid REFERENCES fundraisers(id),
  ADD COLUMN milestone_pct smallint;
CREATE UNIQUE INDEX posts_milestone_once
  ON posts (community_id, fundraiser_id, milestone_pct) WHERE kind = 'milestone';

-- In-app notifications
CREATE TABLE notifications (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  type         text NOT NULL CHECK (type IN ('milestone')),
  target_type  text NOT NULL,
  target_id    uuid NOT NULL,
  payload      jsonb NOT NULL,       -- threshold_pct, raised_cents, donor_count, title
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  dedupe_key   text NOT NULL UNIQUE  -- user:fundraiser:pct
);
CREATE INDEX notifications_inbox_idx  ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- What a signed-in visitor last saw. Guests keep theirs in the browser.
CREATE TABLE visit_snapshots (
  user_id       uuid NOT NULL REFERENCES users(id),
  target_type   text NOT NULL CHECK (target_type IN ('fundraiser','community')),
  target_id     uuid NOT NULL,
  seen_at       timestamptz NOT NULL,
  raised_cents  bigint NOT NULL DEFAULT 0,
  donor_count   integer NOT NULL DEFAULT 0,
  update_count  integer NOT NULL DEFAULT 0,   -- milestone and member posts seen
  PRIMARY KEY (user_id, target_type, target_id)
);
