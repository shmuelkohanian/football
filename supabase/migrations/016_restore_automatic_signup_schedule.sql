-- Roll back the temporary manual signup controls from migration 015.
-- Signup is again governed only by the Sunday 09:00–Monday 09:00
-- Asia/Jerusalem schedule, with automatic finalization on Monday.

drop function if exists public.set_signup_open(boolean);

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
  if extract(isodow from local_now) <> 1 or local_now::time < time '09:00' or local_now::time >= time '10:00' then
    return;
  end if;
  v_week := local_now::date - 1;
  return query select * from private.finalize_weekly_signup_internal(v_week);
end;
$$;

grant execute on function public.signup_week_for_now() to anon, authenticated;
grant execute on function public.finalize_due_signup() to service_role;
