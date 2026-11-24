-- Signup is controlled only by the weekly Israel-time schedule:
-- Sunday 09:00 through Monday 09:00. Manual manager overrides are disabled.
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
begin
  if exists (
    select 1 from public.matches m
    where m.week_start = sunday and m.status <> 'signup'
  ) then
    return null;
  end if;

  if local_now < sunday + time '09:00'
     or local_now >= (sunday + 1) + time '09:00' then
    return null;
  end if;
  return sunday;
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
  -- The hourly Cloudflare Worker invokes this at minute 0. Israel's UTC
  -- offset is a whole number of hours, so Monday 09:00 local is exact.
  if extract(isodow from local_now) <> 1 or local_now::time < time '09:00' or local_now::time >= time '10:00' then
    return;
  end if;
  v_week := local_now::date - 1;
  return query select * from private.finalize_weekly_signup_internal(v_week);
end;
$$;

-- Remove the manager RPC that previously allowed manual opening or closing.
drop function if exists public.set_signup_open(boolean);

grant execute on function public.signup_week_for_now() to anon, authenticated;
grant execute on function public.finalize_due_signup() to service_role;
