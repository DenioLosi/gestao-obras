alter table if exists public.unit_stages
  add column if not exists due_date date;

alter table if exists public.issues
  add column if not exists started_at timestamptz,
  add column if not exists due_date date;

update public.issues
set started_at = coalesce(started_at, created_at)
where started_at is null;

create index if not exists issues_assigned_to_due_date_status_idx
  on public.issues (assigned_to, due_date, status);
