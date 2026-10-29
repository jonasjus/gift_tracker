-- Gift Tracker schema.
-- Every row is private to its owner unless it is attached to a group; group
-- members then share it. A shared person can be linked to a group member's own
-- account (member_id) so that member never sees the gifts planned for them.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null default '',
  currency text not null default 'NOK' check (currency ~ '^[A-Z]{3}$'),
  country text not null default 'Norway',
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_by uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

create table public.people (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  group_id uuid references public.groups on delete set null,
  member_id uuid references auth.users on delete set null,
  name text not null check (length(trim(name)) > 0),
  relation text not null default '',
  country text not null default '',
  birthday date,
  budget numeric(12, 2) not null default 0 check (budget >= 0),
  likes text not null default '',
  created_at timestamptz not null default now()
);
create index people_owner_idx on public.people (owner_id);
create index people_group_idx on public.people (group_id);

create table public.occasions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  group_id uuid references public.groups on delete set null,
  name text not null check (length(trim(name)) > 0),
  date date not null,
  created_at timestamptz not null default now()
);
create index occasions_owner_idx on public.occasions (owner_id);
create index occasions_group_idx on public.occasions (group_id);

create table public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people on delete cascade,
  text text not null check (length(trim(text)) > 0),
  price numeric(12, 2) not null default 0 check (price >= 0),
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index wishlist_items_person_idx on public.wishlist_items (person_id);

create table public.gifts (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people on delete cascade,
  occasion_id uuid references public.occasions on delete set null,
  for_birthday boolean not null default false,
  title text not null check (length(trim(title)) > 0),
  store text not null default '',
  price numeric(12, 2) not null default 0 check (price >= 0),
  status text not null default 'idea' check (status in ('idea', 'bought', 'given')),
  bought_by uuid references auth.users on delete set null,
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now(),
  check (not (for_birthday and occasion_id is not null))
);
create index gifts_person_idx on public.gifts (person_id);
create index gifts_occasion_idx on public.gifts (occasion_id);

-- ---------------------------------------------------------------------------
-- Access helpers (security definer so policies don't recurse through RLS)
-- ---------------------------------------------------------------------------

create function public.is_group_member(gid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from group_members where group_id = gid and user_id = auth.uid());
$$;

create function public.shares_group_with(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from group_members a join group_members b on a.group_id = b.group_id
    where a.user_id = auth.uid() and b.user_id = uid
  );
$$;

create function public.can_access_person(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from people p
    where p.id = pid
      and (p.owner_id = auth.uid() or (p.group_id is not null and is_group_member(p.group_id)))
  );
$$;

-- Like can_access_person, but false for the recipient themselves.
create function public.can_see_gifts(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from people p
    where p.id = pid
      and p.member_id is distinct from auth.uid()
      and (p.owner_id = auth.uid() or (p.group_id is not null and is_group_member(p.group_id)))
  );
$$;

revoke execute on function public.is_group_member(uuid), public.shares_group_with(uuid),
  public.can_access_person(uuid), public.can_see_gifts(uuid) from anon, public;
grant execute on function public.is_group_member(uuid), public.shares_group_with(uuid),
  public.can_access_person(uuid), public.can_see_gifts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- New sign-ups get a profile; the display name comes from sign-up metadata.
create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only the owner may change who a person is shared with or linked to, and the
-- linked account must belong to that group. Others may only make the cleanup
-- changes that follow a group being deleted or a member leaving.
create function public.guard_people()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.owner_id <> old.owner_id then
      raise exception 'The owner of a person cannot be changed';
    end if;
    if auth.uid() is distinct from old.owner_id then
      if new.group_id is distinct from old.group_id
         and not (new.group_id is null and not exists (select 1 from groups where id = old.group_id)) then
        raise exception 'Only the person who added % can change who it is shared with', old.name;
      end if;
      if new.member_id is distinct from old.member_id
         and not (new.member_id is null
                  and (new.group_id is null
                       or not exists (select 1 from group_members where group_id = old.group_id and user_id = old.member_id))) then
        raise exception 'Only the person who added % can change who it is linked to', old.name;
      end if;
    end if;
  end if;
  if new.group_id is null then
    new.member_id := null;
  end if;
  if new.member_id is not null then
    if new.member_id = new.owner_id then
      raise exception 'You cannot hide gifts from yourself';
    end if;
    if not exists (select 1 from group_members where group_id = new.group_id and user_id = new.member_id) then
      raise exception 'That account is not a member of the group';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_people before insert or update on public.people
  for each row execute function public.guard_people();

-- When someone leaves a group, unlink them from people they were linked to.
create function public.unlink_departed_member()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update people set member_id = null where group_id = old.group_id and member_id = old.user_id;
  return old;
end;
$$;
create trigger unlink_departed_member after delete on public.group_members
  for each row execute function public.unlink_departed_member();

-- ---------------------------------------------------------------------------
-- Group RPCs (inserts into groups/group_members only happen through these)
-- ---------------------------------------------------------------------------

create function public.create_group(group_name text)
returns public.groups language plpgsql security definer set search_path = public as $$
declare g groups;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into groups (name, created_by) values (trim(group_name), auth.uid()) returning * into g;
  insert into group_members (group_id, user_id) values (g.id, auth.uid());
  return g;
end;
$$;

create function public.join_group(code text)
returns public.groups language plpgsql security definer set search_path = public as $$
declare g groups;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into g from groups where invite_code = upper(trim(code));
  if g.id is null then raise exception 'No group has the invite code %', upper(trim(code)); end if;
  insert into group_members (group_id, user_id) values (g.id, auth.uid()) on conflict do nothing;
  return g;
end;
$$;

revoke execute on function public.create_group(text), public.join_group(text) from anon, public;
grant execute on function public.create_group(text), public.join_group(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.people enable row level security;
alter table public.occasions enable row level security;
alter table public.wishlist_items enable row level security;
alter table public.gifts enable row level security;

create policy "Read own and group-mates' profiles" on public.profiles for select to authenticated
  using (id = auth.uid() or shares_group_with(id));
create policy "Update own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "Members read their groups" on public.groups for select to authenticated
  using (is_group_member(id));
create policy "Creator renames group" on public.groups for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy "Creator deletes group" on public.groups for delete to authenticated
  using (created_by = auth.uid());

create policy "Members see each other" on public.group_members for select to authenticated
  using (is_group_member(group_id));
create policy "Leave a group, or creator removes a member" on public.group_members for delete to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from public.groups g where g.id = group_id and g.created_by = auth.uid()));

create policy "Read own or group people" on public.people for select to authenticated
  using (owner_id = auth.uid() or (group_id is not null and is_group_member(group_id)));
create policy "Add own people" on public.people for insert to authenticated
  with check (owner_id = auth.uid() and (group_id is null or is_group_member(group_id)));
create policy "Edit own or group people" on public.people for update to authenticated
  using (owner_id = auth.uid() or (group_id is not null and is_group_member(group_id)))
  with check (owner_id = auth.uid() or (group_id is not null and is_group_member(group_id)));
create policy "Owner removes people" on public.people for delete to authenticated
  using (owner_id = auth.uid());

create policy "Read own or group occasions" on public.occasions for select to authenticated
  using (owner_id = auth.uid() or (group_id is not null and is_group_member(group_id)));
create policy "Add own occasions" on public.occasions for insert to authenticated
  with check (owner_id = auth.uid() and (group_id is null or is_group_member(group_id)));
create policy "Owner edits occasions" on public.occasions for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and (group_id is null or is_group_member(group_id)));
create policy "Owner removes occasions" on public.occasions for delete to authenticated
  using (owner_id = auth.uid());

create policy "Wishlist follows the person" on public.wishlist_items for all to authenticated
  using (can_access_person(person_id)) with check (can_access_person(person_id));

create policy "Gifts follow the person, hidden from the recipient" on public.gifts for all to authenticated
  using (can_see_gifts(person_id)) with check (can_see_gifts(person_id));

-- ---------------------------------------------------------------------------
-- Realtime: group members see each other's changes live
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table
  public.people, public.occasions, public.wishlist_items, public.gifts, public.group_members, public.groups;
