alter table if exists public.projects
  add column if not exists progress numeric(6,2) not null default 0,
  add column if not exists status text not null default 'pending';

create or replace function public.recalculate_unit_progress(p_unit_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
  v_total_stages integer := 0;
  v_done_stages integer := 0;
  v_progress numeric(6,2) := 0;
  v_status text := 'pending';
begin
  select units.project_id
    into v_project_id
  from public.units
  where units.id = p_unit_id;

  if v_project_id is null then
    raise exception 'Unidade nao encontrada: %', p_unit_id;
  end if;

  with ranked_stages as (
    select
      us.id,
      us.status,
      us.is_active,
      us.stage_id,
      st.is_active as stage_template_active,
      row_number() over (
        partition by coalesce(us.stage_id::text, 'row:' || us.id::text)
        order by
          case coalesce(us.status, 'pending')
            when 'done' then 2
            when 'in_progress' then 1
            else 0
          end desc,
          case when nullif(btrim(coalesce(us.notes, '')), '') is not null then 1 else 0 end desc,
          coalesce((select count(*) from public.unit_stage_photos usp where usp.unit_stage_id = us.id), 0) desc,
          coalesce((select count(*) from public.unit_stage_logs usl where usl.unit_stage_id = us.id), 0) desc,
          case when us.started_at is not null then 1 else 0 end desc,
          case when us.due_date is not null then 1 else 0 end desc,
          coalesce(us.order_index, 0) asc,
          us.id asc
      ) as row_rank
    from public.unit_stages us
    left join public.stages st
      on st.id = us.stage_id
    where us.unit_id = p_unit_id
  ),
  valid_stages as (
    select *
    from ranked_stages
    where row_rank = 1
      and coalesce(is_active, true)
      and (stage_id is null or coalesce(stage_template_active, true))
  ),
  aggregated as (
    select
      count(*)::integer as total_stages,
      count(*) filter (where coalesce(status, 'pending') = 'done')::integer as done_stages
    from valid_stages
  )
  select
    aggregated.total_stages,
    aggregated.done_stages
  into
    v_total_stages,
    v_done_stages
  from aggregated;

  if coalesce(v_total_stages, 0) > 0 then
    v_progress := round(((v_done_stages::numeric / v_total_stages::numeric) * 100)::numeric, 2);
  else
    v_progress := 0;
  end if;

  if coalesce(v_total_stages, 0) = 0 or v_progress = 0 then
    v_status := 'pending';
  elsif v_progress >= 100 then
    v_status := 'done';
  else
    v_status := 'in_progress';
  end if;

  update public.units
  set
    progress = v_progress,
    status = v_status
  where id = p_unit_id;

  return jsonb_build_object(
    'unit_id', p_unit_id,
    'project_id', v_project_id,
    'progress', v_progress,
    'status', v_status,
    'total_stages', v_total_stages,
    'done_stages', v_done_stages
  );
end;
$$;

create or replace function public.recalculate_project_progress(p_project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_units integer := 0;
  v_zero_units integer := 0;
  v_done_units integer := 0;
  v_progress numeric(6,2) := 0;
  v_status text := 'pending';
begin
  if not exists (
    select 1
    from public.projects
    where projects.id = p_project_id
  ) then
    raise exception 'Obra nao encontrada: %', p_project_id;
  end if;

  with aggregated as (
    select
      count(*)::integer as total_units,
      coalesce(avg(coalesce(units.progress, 0)), 0)::numeric(6,2) as avg_progress,
      count(*) filter (where coalesce(units.progress, 0) <= 0)::integer as zero_units,
      count(*) filter (where coalesce(units.progress, 0) >= 100)::integer as done_units
    from public.units
    where units.project_id = p_project_id
      and coalesce(units.is_active, true)
  )
  select
    aggregated.total_units,
    aggregated.avg_progress,
    aggregated.zero_units,
    aggregated.done_units
  into
    v_total_units,
    v_progress,
    v_zero_units,
    v_done_units
  from aggregated;

  if coalesce(v_total_units, 0) = 0 or v_zero_units = v_total_units then
    v_status := 'pending';
    v_progress := coalesce(v_progress, 0);
  elsif v_done_units = v_total_units then
    v_status := 'done';
  else
    v_status := 'in_progress';
  end if;

  update public.projects
  set
    progress = round(coalesce(v_progress, 0)::numeric, 2),
    status = v_status
  where id = p_project_id;

  return jsonb_build_object(
    'project_id', p_project_id,
    'progress', round(coalesce(v_progress, 0)::numeric, 2),
    'status', v_status,
    'total_units', v_total_units
  );
end;
$$;

create or replace function public.recalculate_unit_and_project_progress(p_unit_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit_result jsonb;
  v_project_result jsonb;
  v_project_id uuid;
begin
  v_unit_result := public.recalculate_unit_progress(p_unit_id);
  v_project_id := nullif(v_unit_result ->> 'project_id', '')::uuid;

  if v_project_id is null then
    raise exception 'Projeto nao encontrado para a unidade: %', p_unit_id;
  end if;

  v_project_result := public.recalculate_project_progress(v_project_id);

  return jsonb_build_object(
    'unit', v_unit_result,
    'project', v_project_result
  );
end;
$$;

do $$
declare
  unit_row record;
  project_row record;
begin
  for unit_row in
    select units.id
    from public.units
  loop
    perform public.recalculate_unit_progress(unit_row.id);
  end loop;

  for project_row in
    select projects.id
    from public.projects
  loop
    perform public.recalculate_project_progress(project_row.id);
  end loop;
end;
$$;
