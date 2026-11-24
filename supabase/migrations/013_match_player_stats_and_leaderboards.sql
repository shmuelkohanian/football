-- Persist per-player match goals/assists and expose monthly leaderboards to
-- approved members. Meeting month is determined by the Monday after week_start.
alter table public.match_entries
  add column if not exists goals integer not null default 0,
  add column if not exists assists integer not null default 0;

alter table public.match_entries
  drop constraint if exists match_entries_goals_range_check,
  drop constraint if exists match_entries_assists_range_check;

alter table public.match_entries
  add constraint match_entries_goals_range_check check (goals between 0 and 14),
  add constraint match_entries_assists_range_check check (assists between 0 and 14);

create or replace function public.save_match_attendance(p_match_id uuid, p_attendance jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_registered_count integer;
  v_decision_count integer;
  v_distinct_player_count integer;
  v_item jsonb;
  v_value numeric;
  v_field text;
begin
  if not public.is_manager() then raise exception 'Manager access required'; end if;
  if jsonb_typeof(p_attendance) <> 'array' then raise exception 'Attendance must be an array'; end if;
  if not exists (
    select 1 from public.matches m where m.id = p_match_id and m.status = 'selected'
  ) then
    raise exception 'Match is not awaiting attendance';
  end if;

  select count(*)::integer into v_registered_count
  from public.match_entries e
  where e.match_id = p_match_id and e.cancelled_at is null;

  select count(*)::integer, count(distinct item->>'player_id')::integer
  into v_decision_count, v_distinct_player_count
  from jsonb_array_elements(p_attendance) item;

  if v_decision_count <> v_registered_count or v_distinct_player_count <> v_decision_count then
    raise exception 'Choose one attendance status for every registrant';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_attendance) item
    where item->>'player_id' is null
       or item->>'status' is null
       or item->>'status' not in ('attended', 'late', 'no_show', 'excused')
       or not exists (
         select 1 from public.match_entries e
         where e.match_id = p_match_id
           and e.cancelled_at is null
           and e.player_id = (item->>'player_id')::uuid
       )
  ) then
    raise exception 'Attendance contains an invalid registrant or status';
  end if;

  for v_item in select value from jsonb_array_elements(p_attendance) loop
    if v_item->>'status' in ('attended', 'late') then
      foreach v_field in array array['goals', 'assists'] loop
        if v_item ? v_field then
          if jsonb_typeof(v_item->v_field) <> 'number' then
            raise exception 'Goals and assists must be whole numbers from 0 to 14';
          end if;
          v_value := (v_item->>v_field)::numeric;
          if v_value < 0 or v_value > 14 or v_value <> trunc(v_value) then
            raise exception 'Goals and assists must be whole numbers from 0 to 14';
          end if;
        end if;
      end loop;
    end if;
  end loop;

  update public.match_entries e
  set attendance_status = item->>'status',
      result = case item->>'status'
        when 'attended' then 'attended'::public.participation_result
        when 'no_show' then 'no_show'::public.participation_result
        else e.result
      end,
      goals = case when item->>'status' in ('attended', 'late') then coalesce((item->>'goals')::integer, 0) else 0 end,
      assists = case when item->>'status' in ('attended', 'late') then coalesce((item->>'assists')::integer, 0) else 0 end
  from jsonb_array_elements(p_attendance) item
  where e.match_id = p_match_id
    and e.cancelled_at is null
    and e.player_id = (item->>'player_id')::uuid;

  update public.matches set status = 'completed' where id = p_match_id;
end;
$$;

revoke execute on function public.save_match_attendance(uuid, jsonb) from public, anon;
grant execute on function public.save_match_attendance(uuid, jsonb) to authenticated;

create or replace function public.get_personal_leaderboards()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := timezone('Asia/Jerusalem', now())::date;
  v_current_month date;
  v_previous_month date;
  v_previous_end date;
  v_previous_last_monday date;
  v_previous_ready boolean;
  v_result jsonb;
begin
  if not exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.status = 'approved'
  ) then raise exception 'Approved membership required'; end if;

  v_current_month := date_trunc('month', v_today)::date;
  v_previous_month := (v_current_month - interval '1 month')::date;
  v_previous_end := v_current_month - 1;
  v_previous_last_monday := v_previous_end - ((extract(isodow from v_previous_end)::integer - 1) % 7);

  select exists (
    select 1 from public.matches m
    where m.week_start + 1 = v_previous_last_monday
      and m.status = 'completed'
  ) into v_previous_ready;

  with monthly_scores as (
    select case when m.week_start + 1 >= v_current_month then 'current' else 'previous' end as period,
      stats.category,
      e.player_id,
      p.first_name,
      p.last_name,
      sum(stats.amount)::bigint as total
    from public.matches m
    join public.match_entries e on e.match_id = m.id and e.cancelled_at is null
    join public.profiles p on p.id = e.player_id and p.status = 'approved'
    cross join lateral (values ('goals'::text, e.goals), ('assists'::text, e.assists)) as stats(category, amount)
    where m.status = 'completed'
      and e.attendance_status in ('attended', 'late')
      and m.week_start + 1 >= v_previous_month
      and m.week_start + 1 < v_current_month + interval '1 month'
      and (m.week_start + 1 >= v_current_month or v_previous_ready)
    group by period, stats.category, e.player_id, p.first_name, p.last_name
  ), ranked as (
    select monthly_scores.*,
      rank() over (partition by period, category order by total desc)::integer as place
    from monthly_scores
  )
  select jsonb_build_object(
    'previous_ready', v_previous_ready,
    'current_month', v_current_month,
    'previous_month', v_previous_month,
    'current_goals', coalesce((select jsonb_agg(jsonb_build_object('player_id', r.player_id, 'first_name', r.first_name, 'last_name', r.last_name, 'total', r.total, 'place', r.place) order by r.place, r.last_name, r.first_name) from ranked r where r.period = 'current' and r.category = 'goals' and r.place <= 10), '[]'::jsonb),
    'current_assists', coalesce((select jsonb_agg(jsonb_build_object('player_id', r.player_id, 'first_name', r.first_name, 'last_name', r.last_name, 'total', r.total, 'place', r.place) order by r.place, r.last_name, r.first_name) from ranked r where r.period = 'current' and r.category = 'assists' and r.place <= 10), '[]'::jsonb),
    'previous_goals', coalesce((select jsonb_agg(jsonb_build_object('player_id', r.player_id, 'first_name', r.first_name, 'last_name', r.last_name, 'total', r.total, 'place', r.place) order by r.place, r.last_name, r.first_name) from ranked r where r.period = 'previous' and r.category = 'goals' and r.place <= 3), '[]'::jsonb),
    'previous_assists', coalesce((select jsonb_agg(jsonb_build_object('player_id', r.player_id, 'first_name', r.first_name, 'last_name', r.last_name, 'total', r.total, 'place', r.place) order by r.place, r.last_name, r.first_name) from ranked r where r.period = 'previous' and r.category = 'assists' and r.place <= 3), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_personal_leaderboards() from public, anon;
grant execute on function public.get_personal_leaderboards() to authenticated;
