-- Managers can mark an eligible player absent from the most recently closed
-- signup. Selected players default to attended; this action changes only that
-- one player's result for that one match.
create function public.add_absence_for_closed_signup(p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match_id uuid;
begin
  if not public.is_manager() then
    raise exception 'Manager access required';
  end if;

  select m.id into v_match_id
  from public.matches m
  where m.week_start = (select max(latest.week_start) from public.matches latest)
    and m.status in ('selected', 'completed')
    and m.selection_completed_at is not null
  order by m.week_start desc
  limit 1;

  if v_match_id is null then
    raise exception 'No closed signup found';
  end if;

  update public.match_entries e
  set result = 'no_show'::public.participation_result
  where e.match_id = v_match_id
    and e.player_id = p_player_id
    and e.selection_rank is not null
    and e.result in ('selected', 'attended');

  if not found then
    raise exception 'No eligible player in latest closed signup';
  end if;
end;
$$;

revoke execute on function public.add_absence_for_closed_signup(uuid) from public, anon;
grant execute on function public.add_absence_for_closed_signup(uuid) to authenticated;
