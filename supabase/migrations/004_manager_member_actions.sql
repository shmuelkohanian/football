-- Changing membership and manager roles is restricted to authenticated
-- managers. Removing a member returns the account to pending and clears any
-- manager role while keeping the account and attendance history intact.
create or replace function public.revoke_member_approval(p_player_id uuid)
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
  set status = 'pending', role = 'player', approved_at = null, approved_by = null
  where id = p_player_id and status = 'approved' and id <> auth.uid();

  if not found then
    raise exception 'Approved member not found or cannot revoke own approval';
  end if;
end;
$$;

create function public.set_member_role(p_player_id uuid, p_role public.member_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_manager() then
    raise exception 'Manager access required';
  end if;
  if p_player_id = auth.uid() then
    raise exception 'Cannot change your own manager role';
  end if;

  update public.profiles
  set role = p_role
  where id = p_player_id and status = 'approved';

  if not found then
    raise exception 'Approved member not found';
  end if;
end;
$$;

revoke execute on function public.set_member_role(uuid, public.member_role) from public, anon;
grant execute on function public.set_member_role(uuid, public.member_role) to authenticated;
