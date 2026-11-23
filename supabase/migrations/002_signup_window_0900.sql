-- Weekly signup runs Sunday 09:00 through Monday 09:00 in Israel time.
create or replace function public.signup_week_for_now()
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  local_now timestamp := timezone('Asia/Jerusalem', now());
  sunday date := local_now::date - extract(dow from local_now)::integer;
begin
  if local_now < sunday + time '09:00'
     or local_now >= (sunday + 1) + time '09:00' then
    return null;
  end if;
  return sunday;
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
  if local_now < (p_week + 1) + time '09:00' then raise exception 'Signup is still open'; end if;
  return query select * from private.finalize_weekly_signup_internal(p_week);
end;
$$;

-- The hourly Worker selects players only during Monday 09:00-09:59 Israel time.
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
