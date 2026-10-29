-- Group members can pick ("claim") a gift they will give, so nobody else buys it.
-- Once picked, only the person who picked it can release it, change its status
-- or delete it. Marking a gift bought picks it for whoever bought it.

alter table public.gifts
  add column claimed_by uuid references auth.users on delete set null;

-- Gifts already bought or given count as picked by whoever bought them.
update public.gifts set claimed_by = bought_by where bought_by is not null;

create function public.claimer_name(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(display_name, ''), 'Someone else') from profiles where id = uid;
$$;

create function public.guard_gift_claims()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Cascades (a person or user being deleted) and calls without a user skip the checks.
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.claimed_by is not null and old.claimed_by <> auth.uid() then
      raise exception '% is giving this gift, so only they can remove it', claimer_name(old.claimed_by);
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.claimed_by is not null and new.claimed_by <> auth.uid() then
      raise exception 'You can only pick gifts for yourself';
    end if;
  else
    if old.claimed_by is not null and old.claimed_by <> auth.uid() then
      if new.claimed_by is distinct from old.claimed_by then
        raise exception '% is already giving this gift', claimer_name(old.claimed_by);
      end if;
      if new.status is distinct from old.status or new.bought_by is distinct from old.bought_by then
        raise exception '% is giving this gift, so only they can change its status', claimer_name(old.claimed_by);
      end if;
    end if;
    if new.claimed_by is distinct from old.claimed_by and new.claimed_by is not null and new.claimed_by <> auth.uid() then
      raise exception 'You can only pick gifts for yourself';
    end if;
  end if;

  -- Buying a gift picks it.
  if new.status <> 'idea' and new.claimed_by is null then
    new.claimed_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger guard_gift_claims before insert or update or delete on public.gifts
  for each row execute function public.guard_gift_claims();

revoke execute on function public.claimer_name(uuid) from anon, public;
grant execute on function public.claimer_name(uuid) to authenticated;
