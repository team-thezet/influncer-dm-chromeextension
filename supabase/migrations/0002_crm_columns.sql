-- Dashboard-managed CRM fields on outreach_targets.
--
-- The extension's sync is one-way (extension → DB) and its mapTarget() payload
-- (src/lib/sync.js) never includes these columns, so values edited in the web
-- dashboard are DURABLE — a later sync upserts only the columns it sends and leaves
-- these untouched. This is why dashboard status/notes live here instead of reusing
-- the synced `status` column (which the extension would clobber).
--
--   crm_status : dashboard CRM lifecycle — '' | pending | contacted | replied | excluded
--   note       : free-text memo
--
-- Not auto-run. Apply with `supabase db push` or paste into the Supabase SQL editor.

alter table public.outreach_targets add column if not exists crm_status text;
alter table public.outreach_targets add column if not exists note       text;
