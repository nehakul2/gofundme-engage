-- Where a fundraiser is. Optional: set when the organizer gives a US zip code.
-- lat/lng let "near me" suggestions use distance; city/state are for display.
ALTER TABLE fundraisers
  ADD COLUMN city        text,
  ADD COLUMN state       char(2),
  ADD COLUMN postal_code text,
  ADD COLUMN lat         double precision,
  ADD COLUMN lng         double precision;
CREATE INDEX fundraisers_geo_idx ON fundraisers (lat, lng) WHERE lat IS NOT NULL AND status = 'active';
