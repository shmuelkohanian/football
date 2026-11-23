-- Weekly football signup, approvals, and eight-week attendance history.
-- Apply through the Supabase SQL editor or Supabase CLI migrations.

create extension if not exists pgcrypto;

create type public.member_status as enum ('pending', 'approved', 'rejected');
create type public.member_role as enum ('player', 'manager');
create type public.match_status as enum ('signup', 'selected', 'completed');
create type public.participation_result as enum ('selected', 'attended', 'no_show', 'not_selected');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null check (length(trim(first_name)) between 1 and 80),
  last_name text not null check (length(trim(last_name)) between 1 and 80),
  community_registered boolean not null default false,
  status public.member_status not null default 'pending',
  role public.member_role not null default 'player',
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references public.profiles(id)
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  status public.match_status not null default 'signup',
  signup_closed_at timestamptz,
  selection_completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.match_entries (
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id uuid not null references public.profiles(id) on delete cascade,
  signed_up_at timestamptz not null default now(),
  cancelled_at timestamptz,
  result public.participation_result not null default 'selected',
  selection_rank integer,
  primary key (match_id, player_id),
  check (selection_rank is null or selection_rank > 0),
  check (result <> 'no_show' or selection_rank is not null),
  check (result <> 'attended' or selection_rank is not null)
);

create index match_entries_player_match_idx on public.match_entries (player_id, match_id);
create index matches_week_status_idx on public.matches (week_start desc, status);

-- New Auth accounts are held pending approval until a manager acts.
create function public.create_pending_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, first_name, last_name, community_registered)
  values (
    new.id,
    trim(coalesce(new.raw_user_meta_data ->> 'first_name', '')),
    trim(coalesce(new.raw_user_meta_data ->> 'last_name', '')),
    coalesce((new.raw_user_meta_data ->> 'community_registered')::boolean, false)
  );
  return new;
end;
$$;

create trigger auth_user_to_pending_profile
after insert on auth.users
for each row execute function public.create_pending_profile();

create function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'manager' and p.status = 'approved'
  );
$$;

-- Sunday 08:00 through Monday 08:00 in Israel time. Sunday is the week's key.
create function public.signup_week_for_now()
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  local_now timestamp := timezone('Asia/Jerusalem', now());
  sunday date := local_now::date - extract(dow from local_now)::integer;
begin
  if local_now < sunday + time '08:00'
     or local_now >= (sunday + 1) + time '08:00' then
    return null;
  end if;
  return sunday;
end;
$$;

create function public.current_week_start()
returns date
language sql
stable
set search_path = ''
as $$
  select timezone('Asia/Jerusalem', now())::date
    - extract(dow from timezone('Asia/Jerusalem', now()))::integer;
$$;

create function public.request_approval(p_player_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_manager() and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Manager access required';
  end if;
  update public.profiles
  set status = case when p_approve then 'approved'::public.member_status else 'rejected'::public.member_status end,
      approved_at = case when p_approve then now() else null end,
      approved_by = case when p_approve then auth.uid() else null end
  where id = p_player_id and status = 'pending' and id <> auth.uid();
  if not found then raise exception 'Pending request not found'; end if;
end;
$$;

create function public.set_weekly_signup(p_join boolean)
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

-- Managers call this after the Sunday-to-Monday signup window. Selection uses
-- only the eight most recent completed matches and records the lottery order.
create function public.finalize_weekly_signup(p_week date)
returns table (selected_player_id uuid, selected_rank integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match_id uuid;
begin
  if not public.is_manager() and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Manager access required';
  end if;
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
    select m.id, m.week_start from public.matches m
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
  set result = case when r.rank <= 15 then 'selected'::public.participation_result else 'not_selected'::public.participation_result end,
      selection_rank = case when r.rank <= 15 then r.rank::integer else null end
  from ranked r where e.match_id = v_match_id and e.player_id = r.player_id;

  update public.matches set status = 'selected', selection_completed_at = now()
  where id = v_match_id;

  if not exists (
    select 1 from public.match_entries e where e.match_id = v_match_id and e.selection_rank is not null
  ) then
    update public.matches set status = 'completed' where id = v_match_id;
  end if;

  return query
    select e.player_id, e.selection_rank from public.match_entries e
    where e.match_id = v_match_id and e.selection_rank is not null order by e.selection_rank;
end;
$$;

-- Worker-only entry point. A Cloudflare scheduled Worker calls this hourly;
-- this function acts only during Monday 08:00-08:59 Israel time.
create function public.finalize_due_signup()
returns table (selected_player_id uuid, selected_rank integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  local_now timestamp := timezone('Asia/Jerusalem', now());
  v_week date;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service access required';
  end if;
  if extract(isodow from local_now) <> 1 or local_now::time < time '08:00' or local_now::time >= time '09:00' then
    return;
  end if;
  v_week := local_now::date - 1;
  return query select * from public.finalize_weekly_signup(v_week);
end;
$$;

create function public.record_attendance(p_match_id uuid, p_player_id uuid, p_attended boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_manager() then raise exception 'Manager access required'; end if;
  update public.match_entries
  set result = case when p_attended then 'attended'::public.participation_result else 'no_show'::public.participation_result end
  where match_id = p_match_id and player_id = p_player_id and selection_rank is not null;
  if not found then raise exception 'Selected player not found'; end if;

  if not exists (select 1 from public.match_entries e where e.match_id = p_match_id and e.result = 'selected') then
    update public.matches set status = 'completed' where id = p_match_id;
  end if;
end;
$$;

create view public.player_recent_stats
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
  count(*) filter (where e.result = 'attended')::integer as attended_last_8,
  count(*) filter (where e.result = 'no_show')::integer as no_shows_last_8
from public.profiles p
left join public.match_entries e on e.player_id = p.id and e.match_id in (select id from recent_weeks)
where p.status = 'approved'
group by p.id;

alter table public.profiles enable row level security;
alter table public.matches enable row level security;
alter table public.match_entries enable row level security;

revoke all on public.profiles, public.matches, public.match_entries from anon, authenticated;
grant select on public.profiles, public.matches, public.match_entries to authenticated;
grant select on public.player_recent_stats to authenticated;
grant execute on function public.is_manager() to authenticated;
grant execute on function public.signup_week_for_now() to authenticated;
grant execute on function public.current_week_start() to authenticated;
grant execute on function public.request_approval(uuid, boolean) to authenticated;
grant execute on function public.set_weekly_signup(boolean) to authenticated;
grant execute on function public.finalize_weekly_signup(date) to authenticated;
grant execute on function public.finalize_due_signup() to service_role;
grant execute on function public.record_attendance(uuid, uuid, boolean) to authenticated;

create policy "Members read approved players and their own profile"
on public.profiles for select to authenticated
using (status = 'approved' or id = (select auth.uid()) or public.is_manager());

create policy "Signed-in members can read matches"
on public.matches for select to authenticated
using (
  exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.status = 'approved')
  or public.is_manager()
);

create policy "Signed-in members can read entries"
on public.match_entries for select to authenticated
using (
  exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.status = 'approved')
  or public.is_manager()
);
