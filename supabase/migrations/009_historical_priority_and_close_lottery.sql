-- While signup is open, show competition ranks based only on historical
-- attendance and no-shows. Random tie-breaking happens only at finalization.
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
      coalesce(history.no_shows, 0) as no_shows
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
    -- RANK gives tied players the same number and leaves the corresponding
    -- positions vacant (for example 1, 2, 2, 2, 5).
    select c.player_id,
      rank() over (order by c.attended asc, c.no_shows asc)::integer as rank
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
      coalesce(history.attended, 0) as attended,
      coalesce(history.no_shows, 0) as no_shows,
      random() as draw
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
    -- The random draw is first generated at closing and only decides order
    -- among players with identical historical records.
    select c.player_id,
      row_number() over (order by c.attended asc, c.no_shows asc, c.draw asc)::integer as rank
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

revoke execute on function private.finalize_weekly_signup_internal(date) from public, anon, authenticated, service_role;
revoke execute on function private.refresh_signup_priorities(uuid) from public, anon, authenticated, service_role;

-- Recompute open signups so their displayed ranks no longer reflect old lottery values.
do $$
declare
  v_match_id uuid;
begin
  for v_match_id in select m.id from public.matches m where m.status = 'signup' loop
    perform private.refresh_signup_priorities(v_match_id);
  end loop;
end;
$$;
