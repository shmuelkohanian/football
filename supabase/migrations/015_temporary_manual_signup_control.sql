-- Temporary manager controls for opening and closing weekly signup during
-- testing. The regular Sunday 09:00–Monday 09:00 Israel-time schedule remains
-- the default when there is no manager override.

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
    where m.week_start = signup_week and m.status <> 'signup'
  ) then
    signup_week := signup_week + 7;
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
  v_week date := local_now::date - extract(dow from local_now)::integer;
begin
  if not public.is_manager() then
    raise exception 'Manager access required';
  end if;

  if p_is_open then
    if exists (
      select 1 from public.matches m
      where m.week_start = v_week and m.status <> 'signup'
    ) then
      v_week := v_week + 7;
    end if;

    insert into public.signup_overrides (week_start, is_open, updated_by, updated_at)
    values (v_week, true, auth.uid(), now())
    on conflict (week_start) do update
    set is_open = true, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

    insert into public.matches (week_start, status)
    values (v_week, 'signup')
    on conflict (week_start) do nothing;
  else
    v_week := public.signup_week_for_now();
    if v_week is null then
      raise exception 'Signup is already closed';
    end if;

    -- Persist the override and finalize atomically so the public page switches
    -- directly from the signup list to the final ordered roster.
    insert into public.signup_overrides (week_start, is_open, updated_by, updated_at)
    values (v_week, false, auth.uid(), now())
    on conflict (week_start) do update
    set is_open = false, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

    perform 1 from private.finalize_weekly_signup_internal(v_week);
  end if;
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

  -- A manager can leave signup open for testing past the scheduled boundary.
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
