-- Managers can revoke another approved member's access, returning the account
-- to the pending queue. A manager cannot revoke their own access here.
create function public.revoke_member_approval(p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_manager() then
    raise exception 'Manager access required';
  end if;

  update public.profiles
  set status = 'pending', approved_at = null, approved_by = null
  where id = p_player_id and status = 'approved' and id <> auth.uid();

  if not found then
    raise exception 'Approved member not found or cannot revoke own approval';
  end if;
end;
$$;

revoke execute on function public.revoke_member_approval(uuid) from public, anon;
grant execute on function public.revoke_member_approval(uuid) to authenticated;
