-- Store the manager's three-way attendance choice separately from the
-- participation result. Excused absences therefore do not affect either
-- attendance counter.
alter table public.match_entries
  add column if not exists attendance_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.match_entries'::regclass
      and conname = 'match_entries_attendance_status_check'
  ) then
    alter table public.match_entries
      add constraint match_entries_attendance_status_check
      check (attendance_status is null or attendance_status in ('attended', 'no_show', 'excused'));
  end if;
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
       or item->>'status' not in ('attended', 'no_show', 'excused')
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
