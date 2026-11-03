-- The homepage lobby is one more chat room. Its id is a fixed value (see LOBBY_ID in src/lib/chat.ts),
-- not a fundraiser, so the foreign key to fundraisers goes. Fundraiser rooms are still checked in code
-- (resolveFundraiser) before any message is written.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_fundraiser_id_fkey;
