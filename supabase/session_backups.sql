-- Rolling server-side snapshots of the board document.
-- Written automatically BEFORE any save that changes the number of properties,
-- so there is always a way back without depending on anyone remembering to
-- click Export.
--
-- Run this once in the Supabase SQL editor.

create table if not exists session_backups (
  id          bigserial primary key,
  session_id  text not null default 'main',
  saved_at    timestamptz not null default now(),
  reason      text,
  prop_count  int,
  benchmark   jsonb not null
);

create index if not exists session_backups_saved_at_idx
  on session_backups (session_id, saved_at desc);

alter table session_backups disable row level security;

-- Keep the newest 200 snapshots; drop older ones.
create or replace function trim_session_backups() returns trigger as $$
begin
  delete from session_backups
  where id in (
    select id from session_backups
    where session_id = new.session_id
    order by saved_at desc
    offset 200
  );
  return null;
end;
$$ language plpgsql;

drop trigger if exists trim_session_backups_trg on session_backups;
create trigger trim_session_backups_trg
  after insert on session_backups
  for each row execute function trim_session_backups();

-- Inspect what you have:
--   select id, saved_at, reason, prop_count from session_backups order by saved_at desc limit 20;
--
-- Restore a snapshot by id (replace 123):
--   update current_session
--      set benchmark = (select benchmark from session_backups where id = 123),
--          updated_at = now()
--    where id = 'main';
