-- Registration is unlimited. The configured capacity applies only to the
-- selected roster. Keep every registrant's priority rank for the public list.
update public.signup_settings
set max_signups = 15, updated_at = now()
where singleton = true;

alter table public.match_entries
  add column if not exists priority_lottery double precision not null default random();

-- Keep the live priority list up to date while signup is open. Each entry's
-- lottery value is assigned once, so new signups can change the ranking
-- without making existing ties jump around on every refresh.
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
    select e.player_id,
      coalesce(history.attended, 0) as attended,
      coalesce(history.no_shows, 0) as no_shows,
      e.priority_lottery
    from public.match_entries e
    join public.profiles p on p.id = e.player_id and p.status = 'approved'
    left join lateral (
      select count(*) filter (where old_entry.result = 'attended')::integer as attended,
        count(*) filter (where old_entry.result = 'no_show')::integer as no_shows
      from public.match_entries old_entry
      where old_entry.player_id = e.player_id
        and old_entry.match_id in (select recent_weeks.id from recent_weeks)
    ) history on true
    where e.match_id = p_match_id and e.cancelled_at is null
  ), ranked as (
    select c.player_id,
      row_number() over (order by c.attended asc, c.no_shows asc, c.priority_lottery asc)::integer as rank
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

create or replace function public.set_weekly_signup(p_join boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_week date := public.signup_week_for_now();
  v_match_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'approved') then
    raise exception 'Approved membership required';
  end if;
  if v_week is null then raise exception 'Signup is closed'; end if;

  insert into public.matches (week_start, status) values (v_week, 'signup')
  on conflict (week_start) do update set week_start = excluded.week_start
  returning id into v_match_id;

  if exists (select 1 from public.matches m where m.id = v_match_id and m.status <> 'signup') then
    raise exception 'Signup is closed';
  end if;

  -- Serialize signup changes for this match so concurrent requests cannot
  -- leave duplicate or stale priority ranks.
  perform 1 from public.matches m where m.id = v_match_id for update;

  if p_join then
    insert into public.match_entries (match_id, player_id)
    values (v_match_id, auth.uid())
    on conflict (match_id, player_id) do update set
      cancelled_at = null, signed_up_at = now(), result = 'selected', selection_rank = null;
  else
    update public.match_entries set cancelled_at = now()
    where match_id = v_match_id and player_id = auth.uid() and cancelled_at is null;
  end if;

  perform private.refresh_signup_priorities(v_match_id);
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
      coalesce(history.attended, 0) as attended,
      coalesce(history.no_shows, 0) as no_shows,
      e.priority_lottery
    from public.match_entries e
    join public.profiles p on p.id = e.player_id and p.status = 'approved'
    left join lateral (
      select count(*) filter (where old_entry.result = 'attended')::integer as attended,
        count(*) filter (where old_entry.result = 'no_show')::integer as no_shows
      from public.match_entries old_entry
      where old_entry.player_id = e.player_id
        and old_entry.match_id in (select recent_weeks.id from recent_weeks)
    ) history on true
    where e.match_id = v_match_id and e.cancelled_at is null
  ), ranked as (
    select c.player_id,
      row_number() over (order by c.attended asc, c.no_shows asc, c.priority_lottery asc)::integer as rank
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

create or replace function public.record_attendance(p_match_id uuid, p_player_id uuid, p_attended boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capacity integer := public.signup_capacity();
begin
  if not public.is_manager() then raise exception 'Manager access required'; end if;
  update public.match_entries
  set result = case when p_attended then 'attended'::public.participation_result else 'no_show'::public.participation_result end
  where match_id = p_match_id
    and player_id = p_player_id
    and selection_rank between 1 and v_capacity
    and result in ('selected', 'attended', 'no_show');
  if not found then raise exception 'Selected player not found'; end if;

  if not exists (
    select 1 from public.match_entries e
    where e.match_id = p_match_id and e.selection_rank between 1 and v_capacity and e.result = 'selected'
  ) then
    update public.matches set status = 'completed' where id = p_match_id;
  end if;
end;
$$;

create or replace function public.add_absence_for_closed_signup(p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match_id uuid;
  v_capacity integer := public.signup_capacity();
begin
  if not public.is_manager() then raise exception 'Manager access required'; end if;

  select m.id into v_match_id
  from public.matches m
  where m.week_start = (select max(latest.week_start) from public.matches latest)
    and m.status in ('selected', 'completed')
    and m.selection_completed_at is not null
  order by m.week_start desc
  limit 1;
  if v_match_id is null then raise exception 'No closed signup found'; end if;

  update public.match_entries e
  set result = 'no_show'::public.participation_result
  where e.match_id = v_match_id and e.player_id = p_player_id
    and e.selection_rank between 1 and v_capacity
    and e.result in ('selected', 'attended');
  if not found then raise exception 'No eligible player in latest closed signup'; end if;

  if not exists (
    select 1 from public.match_entries e
    where e.match_id = v_match_id and e.selection_rank between 1 and v_capacity and e.result = 'selected'
  ) then
    update public.matches set status = 'completed' where id = v_match_id;
  end if;
end;
$$;

-- Manually closing the signup immediately calculates and persists the full
-- priority list. Scheduled finalization continues to handle automatic closes.
create or replace function public.set_signup_open(p_is_open boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  local_now timestamp := timezone('Asia/Jerusalem', now());
  current_sunday date := local_now::date - extract(dow from local_now)::integer;
  v_week date;
begin
  if not public.is_manager() then raise exception 'Manager access required'; end if;

  if p_is_open then
    v_week := current_sunday;
    if exists (select 1 from public.matches m where m.week_start = current_sunday and m.status <> 'signup') then
      v_week := current_sunday + 7;
    end if;
  else
    v_week := public.signup_week_for_now();
    if v_week is null then raise exception 'Signup is already closed'; end if;
  end if;

  insert into public.signup_overrides (week_start, is_open, updated_by, updated_at)
  values (v_week, p_is_open, auth.uid(), now())
  on conflict (week_start) do update
  set is_open = excluded.is_open, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  if p_is_open then
    insert into public.matches (week_start, status) values (v_week, 'signup')
    on conflict (week_start) do nothing;
  else
    perform private.finalize_weekly_signup_internal(v_week);
  end if;
end;
$$;

revoke execute on function public.set_weekly_signup(boolean) from public, anon;
grant execute on function public.set_weekly_signup(boolean) to authenticated;
revoke execute on function private.finalize_weekly_signup_internal(date) from public, anon, authenticated, service_role;
revoke execute on function private.refresh_signup_priorities(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.record_attendance(uuid, uuid, boolean) from public, anon;
grant execute on function public.record_attendance(uuid, uuid, boolean) to authenticated;
revoke execute on function public.add_absence_for_closed_signup(uuid) from public, anon;
grant execute on function public.add_absence_for_closed_signup(uuid) to authenticated;
revoke execute on function public.set_signup_open(boolean) from public, anon;
grant execute on function public.set_signup_open(boolean) to authenticated;

-- Backfill the live ranking for any signup that was already open when this
-- migration was applied.
do $$
declare
  v_match_id uuid;
begin
  for v_match_id in select m.id from public.matches m where m.status = 'signup' loop
    perform private.refresh_signup_priorities(v_match_id);
  end loop;
end;
$$;
