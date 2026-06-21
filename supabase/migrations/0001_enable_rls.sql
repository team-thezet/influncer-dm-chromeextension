-- Turn ON Row Level Security for the outreach_* tables and make the anon role's
-- access explicit.
--
-- WHY: today RLS is OFF, so the public anon key (shipped in the extension and the
-- dashboard) has unrestricted CRUD on these tables. Enabling RLS means access is
-- governed by explicit policies instead of being implicitly world-open.
--
-- SCOPE / CAVEAT: with only the anon key (no per-user auth), anyone holding the key
-- can still read+write through the policies below — this does NOT make the data
-- private. It (a) flips RLS on so the tables aren't implicitly open, and (b) makes the
-- anon grant explicit and auditable, so you can later tighten to authenticated users
-- (scope `using`/`with check` to auth.uid()) without restructuring.
--
-- Not auto-run. Apply with `supabase db push` or paste into the Supabase SQL editor.
-- Run 0002_crm_columns.sql as well for the dashboard CRM fields.

alter table public.outreach_campaigns enable row level security;
alter table public.outreach_targets   enable row level security;
alter table public.outreach_logs       enable row level security;

-- Idempotent (re)creation of an explicit anon read+write policy per table.
do $$
declare tbl text;
begin
  foreach tbl in array array['outreach_campaigns', 'outreach_targets', 'outreach_logs'] loop
    execute format('drop policy if exists %I on public.%I', tbl || '_anon_all', tbl);
    execute format(
      'create policy %I on public.%I for all to anon using (true) with check (true)',
      tbl || '_anon_all', tbl
    );
  end loop;
end $$;
