create extension if not exists pgcrypto with schema extensions;

create table if not exists public.vault_accounts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint vault_accounts_identity_pair unique (id, auth_user_id)
);

create table if not exists public.vault_cloud_devices (
  id uuid primary key,
  account_id uuid not null,
  auth_user_id uuid not null,
  label text not null check (char_length(label) between 1 and 80),
  platform text not null check (char_length(platform) between 1 and 40),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz null,
  constraint vault_cloud_devices_account_fk
    foreign key (account_id, auth_user_id)
    references public.vault_accounts(id, auth_user_id)
    on delete cascade
);

create table if not exists public.vault_cloud_vaults (
  id uuid primary key,
  account_id uuid not null,
  auth_user_id uuid not null,
  name text not null check (char_length(name) between 1 and 240),
  epoch uuid not null default gen_random_uuid(),
  protocol_version smallint not null default 1 check (protocol_version = 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz null,
  constraint vault_cloud_vaults_account_fk
    foreign key (account_id, auth_user_id)
    references public.vault_accounts(id, auth_user_id)
    on delete cascade
);

create index if not exists vault_cloud_devices_account_idx
  on public.vault_cloud_devices(account_id, created_at);
create index if not exists vault_cloud_vaults_account_idx
  on public.vault_cloud_vaults(account_id, updated_at desc);

alter table public.vault_accounts enable row level security;
alter table public.vault_cloud_devices enable row level security;
alter table public.vault_cloud_vaults enable row level security;

revoke all on public.vault_accounts from anon;
revoke all on public.vault_cloud_devices from anon;
revoke all on public.vault_cloud_vaults from anon;

grant select, insert on public.vault_accounts to authenticated;
grant select, insert, update on public.vault_cloud_devices to authenticated;
grant select, insert, update on public.vault_cloud_vaults to authenticated;

drop policy if exists vault_accounts_select_own on public.vault_accounts;
create policy vault_accounts_select_own
  on public.vault_accounts for select
  to authenticated
  using ((select auth.uid()) = auth_user_id);

drop policy if exists vault_accounts_insert_own on public.vault_accounts;
create policy vault_accounts_insert_own
  on public.vault_accounts for insert
  to authenticated
  with check ((select auth.uid()) = auth_user_id);

drop policy if exists vault_cloud_devices_select_own on public.vault_cloud_devices;
create policy vault_cloud_devices_select_own
  on public.vault_cloud_devices for select
  to authenticated
  using ((select auth.uid()) = auth_user_id);

drop policy if exists vault_cloud_devices_insert_own on public.vault_cloud_devices;
create policy vault_cloud_devices_insert_own
  on public.vault_cloud_devices for insert
  to authenticated
  with check ((select auth.uid()) = auth_user_id);

drop policy if exists vault_cloud_devices_update_own on public.vault_cloud_devices;
create policy vault_cloud_devices_update_own
  on public.vault_cloud_devices for update
  to authenticated
  using ((select auth.uid()) = auth_user_id)
  with check ((select auth.uid()) = auth_user_id);

drop policy if exists vault_cloud_vaults_select_own on public.vault_cloud_vaults;
create policy vault_cloud_vaults_select_own
  on public.vault_cloud_vaults for select
  to authenticated
  using ((select auth.uid()) = auth_user_id);

drop policy if exists vault_cloud_vaults_insert_own on public.vault_cloud_vaults;
create policy vault_cloud_vaults_insert_own
  on public.vault_cloud_vaults for insert
  to authenticated
  with check ((select auth.uid()) = auth_user_id);

drop policy if exists vault_cloud_vaults_update_own on public.vault_cloud_vaults;
create policy vault_cloud_vaults_update_own
  on public.vault_cloud_vaults for update
  to authenticated
  using ((select auth.uid()) = auth_user_id)
  with check ((select auth.uid()) = auth_user_id);

create schema if not exists vault_private;
revoke all on schema vault_private from public, anon, authenticated;

create or replace function vault_private.guard_device_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id
     or new.account_id <> old.account_id
     or new.auth_user_id <> old.auth_user_id
     or new.created_at <> old.created_at then
    raise exception 'immutable device identity fields cannot change';
  end if;
  if old.revoked_at is not null and new.revoked_at is null then
    raise exception 'revoked devices cannot be restored';
  end if;
  return new;
end;
$$;

drop trigger if exists vault_cloud_devices_guard on public.vault_cloud_devices;
create trigger vault_cloud_devices_guard
before update on public.vault_cloud_devices
for each row execute function vault_private.guard_device_update();

create or replace function vault_private.guard_vault_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id
     or new.account_id <> old.account_id
     or new.auth_user_id <> old.auth_user_id
     or new.epoch <> old.epoch
     or new.protocol_version <> old.protocol_version
     or new.created_at <> old.created_at then
    raise exception 'immutable cloud Vault identity fields cannot change';
  end if;
  if old.disabled_at is not null and new.disabled_at is null then
    raise exception 'disabled cloud Vaults cannot be re-enabled implicitly';
  end if;
  return new;
end;
$$;

drop trigger if exists vault_cloud_vaults_guard on public.vault_cloud_vaults;
create trigger vault_cloud_vaults_guard
before update on public.vault_cloud_vaults
for each row execute function vault_private.guard_vault_update();
