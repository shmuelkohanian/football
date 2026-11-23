-- Allow managers to open or close the current week's signup outside its
-- regular Sunday 09:00 to Monday 09:00 Israel-time window.
create table if not exists public.signup_overrides (
  week_start date primary key,
  is_open boolean not null,
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now()
);

alter table public.signup_overrides enable row level security;
revoke all on public.signup_overrides from public, anon, authenticated;

create or replace function public.signup_week_for_now()
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  local_now timestamp := timezone('Asia/Jerusalem', now());
  sunday date := local_now::date - extract(dow from local_now)::integer;
  signup_week date := sunday;
  override_open boolean;
begin
  if exists (
    select 1 from public.matches m
    where m.week_start = sunday and m.status <> 'signup'
  ) then
    signup_week := sunday + 7;
  end if;

  select o.is_open into override_open
  from public.signup_overrides o
  where o.week_start = signup_week;

  if found then
    return case when override_open then signup_week else null end;
  end if;

  if signup_week <> sunday
     or local_now < sunday + time '09:00'
     or local_now >= (sunday + 1) + time '09:00' then
    return null;
  end if;
  return sunday;
end;
$$;

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
  if not public.is_manager() then
    raise exception 'Manager access required';
  end if;

  if p_is_open then
    v_week := current_sunday;
    if exists (
      select 1 from public.matches m
      where m.week_start = current_sunday and m.status <> 'signup'
    ) then
      v_week := current_sunday + 7;
    end if;
  else
    v_week := public.signup_week_for_now();
    if v_week is null then
      raise exception 'Signup is already closed';
    end if;
  end if;

  insert into public.signup_overrides (week_start, is_open, updated_by, updated_at)
  values (v_week, p_is_open, auth.uid(), now())
  on conflict (week_start) do update
  set is_open = excluded.is_open,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

  if p_is_open then
    insert into public.matches (week_start, status)
    values (v_week, 'signup')
    on conflict (week_start) do nothing;
  end if;
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

create or replace function public.finalize_weekly_signup(p_week date)
returns table (selected_player_id uuid, selected_rank integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  local_now timestamp := timezone('Asia/Jerusalem', now());
  this_week date := local_now::date - extract(dow from local_now)::integer;
begin
  if not public.is_manager() then raise exception 'Manager access required'; end if;
  if p_week > this_week then raise exception 'Cannot finalize a future week'; end if;
  if local_now < (p_week + 1) + time '09:00' and not exists (
    select 1 from public.signup_overrides o
    where o.week_start = p_week and o.is_open = false
  ) then
    raise exception 'Signup is still open';
  end if;
  return query select * from private.finalize_weekly_signup_internal(p_week);
end;
$$;

create or replace function public.finalize_due_signup()
returns table (selected_player_id uuid, selected_rank integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  local_now timestamp := timezone('Asia/Jerusalem', now());
  v_week date;
begin
  if extract(isodow from local_now) <> 1 or local_now::time < time '09:00' or local_now::time >= time '10:00' then
    return;
  end if;
  v_week := local_now::date - 1;
  if exists (
    select 1 from public.signup_overrides o
    where o.week_start = v_week and o.is_open = true
  ) then
    return;
  end if;
  return query select * from private.finalize_weekly_signup_internal(v_week);
end;
$$;

revoke execute on function public.set_signup_open(boolean) from public, anon;
grant execute on function public.set_signup_open(boolean) to authenticated;
grant execute on function public.signup_week_for_now() to anon, authenticated;
grant execute on function public.set_weekly_signup(boolean) to authenticated;
grant execute on function public.finalize_weekly_signup(date) to authenticated;
grant execute on function public.finalize_due_signup() to service_role;
