-- Add a distinct late status and rank players by a weighted eight-week
-- record. Attendance is 0.5 points, late arrival 0.75, and a no-show 1.
alter table public.match_entries
  drop constraint if exists match_entries_attendance_status_check;

alter table public.match_entries
  add constraint match_entries_attendance_status_check
  check (attendance_status is null or attendance_status in ('attended', 'late', 'no_show', 'excused'));

create or replace view public.player_recent_stats
with (security_invoker = true)
as
with recent_weeks as (
  select m.id from public.matches m
  where m.status = 'completed'
    and m.week_start >= (
      timezone('Asia/Jerusalem', now())::date
      - extract(dow from timezone('Asia/Jerusalem', now()))::integer
      - 49
    )
    and m.week_start <= (
      timezone('Asia/Jerusalem', now())::date
      - extract(dow from timezone('Asia/Jerusalem', now()))::integer
    )
)
select p.id as player_id,
  count(*) filter (where coalesce(e.attendance_status, e.result::text) = 'attended')::integer as attended_last_8,
  count(*) filter (where coalesce(e.attendance_status, e.result::text) = 'no_show')::integer as no_shows_last_8,
  count(*) filter (where e.attendance_status = 'late')::integer as late_last_8
from public.profiles p
left join public.match_entries e on e.player_id = p.id and e.match_id in (select id from recent_weeks)
where p.status = 'approved'
group by p.id;

create or replace function private.refresh_signup_priorities(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_week date;
begin
  select m.week_start into v_week from public.matches m
  where m.id = p_match_id and m.status = 'signup';
  if v_week is null then return; end if;

  with recent_weeks as (
    select m.id from public.matches m
    where m.status = 'completed'
      and m.week_start >= v_week - 56
      and m.week_start < v_week
  ), candidates as (
    select e.player_id, coalesce(history.bad_points, 0::numeric) as bad_points
    from public.match_entries e
    join public.profiles p on p.id = e.player_id and p.status = 'approved'
    left join lateral (
      select sum(case coalesce(old_entry.attendance_status, old_entry.result::text)
        when 'attended' then 0.5::numeric
        when 'late' then 0.75::numeric
        when 'no_show' then 1::numeric
        else 0::numeric
      end) as bad_points
      from public.match_entries old_entry
      where old_entry.player_id = e.player_id
        and old_entry.match_id in (select recent_weeks.id from recent_weeks)
    ) history on true
    where e.match_id = p_match_id and e.cancelled_at is null
  ), ranked as (
    -- Equal historical scores share a rank; the lottery happens only at close.
    select c.player_id, rank() over (order by c.bad_points asc)::integer as rank
    from candidates c
  )
  update public.match_entries e
  set selection_rank = r.rank
  from ranked r where e.match_id = p_match_id and e.player_id = r.player_id;

  update public.match_entries e
  set selection_rank = null
  where e.match_id = p_match_id and e.cancelled_at is not null;
end;
$$;

create or replace function private.finalize_weekly_signup_internal(p_week date)
returns table (selected_player_id uuid, selected_rank integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match_id uuid;
  v_max_players integer := public.signup_capacity();
begin
  insert into public.matches (week_start, status, signup_closed_at)
  values (p_week, 'signup', now())
  on conflict (week_start) do update set signup_closed_at = coalesce(public.matches.signup_closed_at, now())
  returning id into v_match_id;

  if exists (select 1 from public.matches m where m.id = v_match_id and m.selection_completed_at is not null) then
    return query
      select e.player_id, e.selection_rank from public.match_entries e
      where e.match_id = v_match_id and e.selection_rank is not null
      order by e.selection_rank;
    return;
  end if;

  with recent_weeks as (
    select m.id from public.matches m
    where m.status = 'completed'
      and m.week_start >= p_week - 56
      and m.week_start < p_week
  ), candidates as (
    select e.player_id,
      coalesce(history.bad_points, 0::numeric) as bad_points,
      random() as draw
    from public.match_entries e
    join public.profiles p on p.id = e.player_id and p.status = 'approved'
    left join lateral (
      select sum(case coalesce(old_entry.attendance_status, old_entry.result::text)
        when 'attended' then 0.5::numeric
        when 'late' then 0.75::numeric
        when 'no_show' then 1::numeric
        else 0::numeric
      end) as bad_points
      from public.match_entries old_entry
      where old_entry.player_id = e.player_id
        and old_entry.match_id in (select recent_weeks.id from recent_weeks)
    ) history on true
    where e.match_id = v_match_id and e.cancelled_at is null
  ), ranked as (
    -- Randomness is introduced only now, at closure, and only affects ties.
    select c.player_id,
      row_number() over (order by c.bad_points asc, c.draw asc)::integer as rank
    from candidates c
  )
  update public.match_entries e
  set result = case
        when r.rank <= v_max_players then 'selected'::public.participation_result
        else 'not_selected'::public.participation_result
      end,
      selection_rank = r.rank
  from ranked r where e.match_id = v_match_id and e.player_id = r.player_id;

  update public.matches
  set status = case when exists (
        select 1 from public.match_entries e
        where e.match_id = v_match_id and e.selection_rank <= v_max_players
      ) then 'selected'::public.match_status else 'completed'::public.match_status end,
      selection_completed_at = now()
  where id = v_match_id;

  return query
    select e.player_id, e.selection_rank from public.match_entries e
    where e.match_id = v_match_id and e.selection_rank is not null
    order by e.selection_rank;
end;
$$;

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

  update public.match_entries e
  set attendance_status = item->>'status',
      result = case item->>'status'
        when 'attended' then 'attended'::public.participation_result
        when 'no_show' then 'no_show'::public.participation_result
        else e.result
      end
  from jsonb_array_elements(p_attendance) item
  where e.match_id = p_match_id
    and e.cancelled_at is null
    and e.player_id = (item->>'player_id')::uuid;

  update public.matches set status = 'completed' where id = p_match_id;
end;
$$;

revoke execute on function public.save_match_attendance(uuid, jsonb) from public, anon;
grant execute on function public.save_match_attendance(uuid, jsonb) to authenticated;
revoke execute on function private.finalize_weekly_signup_internal(date) from public, anon, authenticated, service_role;
revoke execute on function private.refresh_signup_priorities(uuid) from public, anon, authenticated, service_role;

-- Recalculate currently open lists using weighted historical points.
do $$
declare
  v_match_id uuid;
begin
  for v_match_id in select m.id from public.matches m where m.status = 'signup' loop
    perform private.refresh_signup_priorities(v_match_id);
  end loop;
end;
$$;
