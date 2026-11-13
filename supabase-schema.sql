-- One Daily Improvement — Supabase schema
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query → Run).
-- Re-running is safe; everything is idempotent.

create extension if not exists pgcrypto;

create table if not exists submissions (
  id              text primary key,
  name            text not null,
  problem         text not null,
  solution        text,
  impact          text,
  problem_photos  jsonb default '[]'::jsonb,
  solution_photos jsonb default '[]'::jsonb,
  status          text default 'open',
  kind            text default 'difficult',
  category        text default 'other',
  assigned_to     text,
  assignees       jsonb,
  assigned_by     text,
  assigned_at     timestamptz,
  assignment_note text,
  improved_by     text,
  improved_at     timestamptz,
  improved_note   text,
  checklist       jsonb default '[]'::jsonb,
  related_to      jsonb default '[]'::jsonb,
  created_at      timestamptz default now()
);
alter table submissions add column if not exists category   text default 'other';
alter table submissions add column if not exists impact     text;
alter table submissions add column if not exists checklist  jsonb default '[]'::jsonb;
alter table submissions add column if not exists related_to jsonb default '[]'::jsonb;
create index if not exists submissions_created_at_idx on submissions (created_at desc);
create index if not exists submissions_status_idx on submissions (status);

create table if not exists reactions (
  id         text primary key,
  entry_id   text not null,
  username   text not null,
  code       text not null,
  created_at timestamptz default now()
);
create index if not exists reactions_entry_id_idx on reactions (entry_id);

create table if not exists comments (
  id         text primary key,
  entry_id   text not null,
  author     text not null,
  text       text not null,
  created_at timestamptz default now()
);
create index if not exists comments_entry_id_idx on comments (entry_id);
create index if not exists comments_created_at_idx on comments (created_at);

create table if not exists updates (
  id         text primary key,
  entry_id   text not null,
  author     text not null,
  text       text not null,
  created_at timestamptz default now()
);
create index if not exists updates_entry_id_idx on updates (entry_id);
create index if not exists updates_created_at_idx on updates (created_at);

-- URL-as-auth: anyone with the deployed URL (and therefore the anon key)
-- can read and write. Same effective security model as the claude.ai artifact
-- when shared with the crew via "Can edit".
alter table submissions enable row level security;
alter table reactions   enable row level security;
alter table comments    enable row level security;
alter table updates     enable row level security;

drop policy if exists anon_all on submissions;
drop policy if exists anon_all on reactions;
drop policy if exists anon_all on comments;
drop policy if exists anon_all on updates;
create policy anon_all on submissions for all using (true) with check (true);
create policy anon_all on reactions   for all using (true) with check (true);
create policy anon_all on comments    for all using (true) with check (true);
create policy anon_all on updates     for all using (true) with check (true);

-- Enable realtime on these tables so every open browser sees live updates.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'submissions'
  ) then alter publication supabase_realtime add table submissions; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reactions'
  ) then alter publication supabase_realtime add table reactions; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comments'
  ) then alter publication supabase_realtime add table comments; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'updates'
  ) then alter publication supabase_realtime add table updates; end if;
end$$;

-- Storage bucket for photos — easiest to create from the dashboard:
--   Storage → New bucket → name "entry-photos" → Public bucket: ON → Save.
-- Then add policies so anyone can upload/read/delete:
--   Storage → entry-photos → Policies → New policy
--   For simple internal-crew use, "Allow access to anon" is fine.
-- Or run this SQL alternative:
-- insert into storage.buckets (id, name, public) values ('entry-photos', 'entry-photos', true)
--   on conflict (id) do update set public = excluded.public;
-- create policy "anon_photos_insert" on storage.objects for insert to anon with check (bucket_id = 'entry-photos');
-- create policy "anon_photos_select" on storage.objects for select to anon using (bucket_id = 'entry-photos');
-- create policy "anon_photos_delete" on storage.objects for delete to anon using (bucket_id = 'entry-photos');
