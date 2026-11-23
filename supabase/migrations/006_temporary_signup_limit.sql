-- Temporary test configuration: only two registrations/selected players.
-- Restore max_signups to 15 after testing.
create table if not exists public.signup_settings (
  singleton boolean primary key default true check (singleton),
  max_signups integer not null check (max_signups between 1 and 15),
  updated_at timestamptz not null default now()
);

insert into public.signup_settings (singleton, max_signups)
values (true, 2)
on conflict (singleton) do update
set max_signups = excluded.max_signups, updated_at = now();

alter table public.signup_settings enable row level security;
revoke all on public.signup_settings from public, anon, authenticated;

create or replace function public.signup_capacity()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select s.max_signups from public.signup_settings s where s.singleton = true;
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
  v_limit integer := public.signup_capacity();
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

  if p_join and not exists (
    select 1 from public.match_entries e
    where e.match_id = v_match_id and e.player_id = auth.uid() and e.cancelled_at is null
  ) and (select count(*) from public.match_entries e where e.match_id = v_match_id and e.cancelled_at is null) >= v_limit then
    raise exception 'Signup is full';
  end if;

  if p_join then
    insert into public.match_entries (match_id, player_id)
    values (v_match_id, auth.uid())
    on conflict (match_id, player_id) do update set
      cancelled_at = null, signed_up_at = now(), result = 'selected', selection_rank = null;
  else
    update public.match_entries set cancelled_at = now()
    where match_id = v_match_id and player_id = auth.uid() and cancelled_at is null;
  end if;
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
      where e.match_id = v_match_id and e.selection_rank is not null order by e.selection_rank;
    return;
  end if;

  with recent_weeks as (
    select m.id from public.matches m
    where m.status = 'completed'
      and m.week_start >= p_week - 56
      and m.week_start < p_week
  ),
  candidates as (
    select e.player_id,
      coalesce(history.attended, 0) as attended,
      coalesce(history.no_shows, 0) as no_shows,
      random() as lottery
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
    group by e.player_id, history.attended, history.no_shows
  ),
  ranked as (
    select c.player_id, row_number() over (order by c.attended asc, c.no_shows asc, c.lottery asc) as rank
    from candidates c
  )
  update public.match_entries e
  set result = case when r.rank <= v_max_players then 'attended'::public.participation_result else 'not_selected'::public.participation_result end,
      selection_rank = case when r.rank <= v_max_players then r.rank::integer else null end
  from ranked r where e.match_id = v_match_id and e.player_id = r.player_id;

  update public.matches set status = 'completed', selection_completed_at = now()
  where id = v_match_id;

  if not exists (select 1 from public.match_entries e where e.match_id = v_match_id and e.selection_rank is not null) then
    update public.matches set status = 'completed' where id = v_match_id;
  end if;

  return query
    select e.player_id, e.selection_rank from public.match_entries e
    where e.match_id = v_match_id and e.selection_rank is not null order by e.selection_rank;
end;
$$;

revoke execute on function public.signup_capacity() from public;
grant execute on function public.signup_capacity() to anon, authenticated;
grant execute on function public.set_weekly_signup(boolean) to authenticated;
revoke execute on function private.finalize_weekly_signup_internal(date) from public, anon, authenticated, service_role;
