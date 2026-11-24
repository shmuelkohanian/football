-- Skip leaderboard aggregation for periods without saved match attendance.
create or replace function public.get_personal_leaderboards()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := timezone('Asia/Jerusalem', now())::date;
  v_current_month date;
  v_previous_month date;
  v_previous_end date;
  v_previous_last_monday date;
  v_previous_ready boolean;
  v_previous_has_data boolean;
  v_current_has_data boolean;
  v_current_goals jsonb := '[]'::jsonb;
  v_current_assists jsonb := '[]'::jsonb;
  v_previous_goals jsonb := '[]'::jsonb;
  v_previous_assists jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.status = 'approved'
  ) then raise exception 'Approved membership required'; end if;

  v_current_month := date_trunc('month', v_today)::date;
  v_previous_month := (v_current_month - interval '1 month')::date;
  v_previous_end := v_current_month - 1;
  v_previous_last_monday := v_previous_end - ((extract(isodow from v_previous_end)::integer - 1) % 7);

  select exists (
    select 1 from public.matches m
    where m.week_start + 1 = v_previous_last_monday
      and m.status = 'completed'
  ) into v_previous_ready;

  select exists (
    select 1
    from public.matches m
    join public.match_entries e on e.match_id = m.id and e.cancelled_at is null
    where m.status = 'completed'
      and e.attendance_status is not null
      and m.week_start + 1 >= v_current_month
      and m.week_start + 1 < v_current_month + interval '1 month'
  ) into v_current_has_data;

  select v_previous_ready and exists (
    select 1
    from public.matches m
    join public.match_entries e on e.match_id = m.id and e.cancelled_at is null
    where m.status = 'completed'
      and e.attendance_status is not null
      and m.week_start + 1 >= v_previous_month
      and m.week_start + 1 < v_current_month
  ) into v_previous_has_data;

  if v_current_has_data or v_previous_has_data then
    with monthly_scores as (
      select case when m.week_start + 1 >= v_current_month then 'current' else 'previous' end as period,
        stats.category,
        e.player_id,
        p.first_name,
        p.last_name,
        sum(stats.amount)::bigint as total
      from public.matches m
      join public.match_entries e on e.match_id = m.id and e.cancelled_at is null
      join public.profiles p on p.id = e.player_id and p.status = 'approved'
      cross join lateral (values ('goals'::text, e.goals), ('assists'::text, e.assists)) as stats(category, amount)
      where m.status = 'completed'
        and e.attendance_status in ('attended', 'late')
        and (
          (v_current_has_data and m.week_start + 1 >= v_current_month and m.week_start + 1 < v_current_month + interval '1 month')
          or (v_previous_has_data and m.week_start + 1 >= v_previous_month and m.week_start + 1 < v_current_month)
        )
      group by period, stats.category, e.player_id, p.first_name, p.last_name
    ), ranked as (
      select monthly_scores.*,
        rank() over (partition by period, category order by total desc)::integer as place
      from monthly_scores
    )
    select
      coalesce((select jsonb_agg(jsonb_build_object('player_id', r.player_id, 'first_name', r.first_name, 'last_name', r.last_name, 'total', r.total, 'place', r.place) order by r.place, r.last_name, r.first_name) from ranked r where r.period = 'current' and r.category = 'goals' and r.place <= 10), '[]'::jsonb),
      coalesce((select jsonb_agg(jsonb_build_object('player_id', r.player_id, 'first_name', r.first_name, 'last_name', r.last_name, 'total', r.total, 'place', r.place) order by r.place, r.last_name, r.first_name) from ranked r where r.period = 'current' and r.category = 'assists' and r.place <= 10), '[]'::jsonb),
      coalesce((select jsonb_agg(jsonb_build_object('player_id', r.player_id, 'first_name', r.first_name, 'last_name', r.last_name, 'total', r.total, 'place', r.place) order by r.place, r.last_name, r.first_name) from ranked r where r.period = 'previous' and r.category = 'goals' and r.place <= 3), '[]'::jsonb),
      coalesce((select jsonb_agg(jsonb_build_object('player_id', r.player_id, 'first_name', r.first_name, 'last_name', r.last_name, 'total', r.total, 'place', r.place) order by r.place, r.last_name, r.first_name) from ranked r where r.period = 'previous' and r.category = 'assists' and r.place <= 3), '[]'::jsonb)
    into v_current_goals, v_current_assists, v_previous_goals, v_previous_assists;
  end if;

  return jsonb_build_object(
    'previous_ready', v_previous_ready,
    'previous_has_data', v_previous_has_data,
    'current_has_data', v_current_has_data,
    'current_month', v_current_month,
    'previous_month', v_previous_month,
    'current_goals', v_current_goals,
    'current_assists', v_current_assists,
    'previous_goals', v_previous_goals,
    'previous_assists', v_previous_assists
  );
end;
$$;

revoke execute on function public.get_personal_leaderboards() from public, anon;
grant execute on function public.get_personal_leaderboards() to authenticated;
notify pgrst, 'reload schema';
