-- Repairs contact names that were overwritten with the OWNER's own display name.
-- Cause: outgoing WhatsApp messages carry the owner's pushName, and the webhook
-- saved it as the contact's name (fixed in src/services/webhookHandler.js).
-- Examples seen: 50 Kitchen And All contacts named "Kitchen And All",
-- 15 VVStudios contacts named "Lloyd Praise", 3 named "VV Studios".
--
-- SAFE TO RE-RUN. It only blanks a name that equals the business's own name or one
-- of the owner names listed below; the real name returns the next time that person
-- messages (incoming messages carry their own pushName).
--
-- CONFIG: add any other display name the owner uses on WhatsApp inside owner_names.

with owner_names(business_id, owner_name) as (values
  ('kitchenandall-020678', 'Kitchen And All'),
  ('kitchenandall-020678', 'Kitchen and All'),
  ('vvstudios-e2b2c2',     'Lloyd Praise'),
  ('vvstudios-e2b2c2',     'VV Studios'),
  ('vvstudios-e2b2c2',     'Kitchen And All')   -- 1 contact, same cause
)
update public.contacts c
   set name = null
  from owner_names o
 where c.business_id = o.business_id
   and lower(btrim(c.name)) = lower(o.owner_name);
