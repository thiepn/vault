-- Phase 18 — Shared Vaults, Membership & Permission Architecture
--
-- Membership changes authorization around the existing owner-scoped canonical
-- event log. The Vault owner remains the storage/history owner; collaborators
-- are actors with owner/editor/viewer roles.

create table if not exists public.vault_memberships (
  vault_id uuid not null references public.vault_cloud_vaults(id) on delete cascade,
  account_id uuid not null,
  auth_user_id uuid not null,
  role text not null check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz null,
  primary key (vault_id,account_id),
  constraint vault_memberships_auth_uq unique (vault_id,auth_user_id),
  constraint vault_memberships_account_fk
    foreign key (account_id,auth_user_id)
    references public.vault_accounts(id,auth_user_id)
    on delete cascade
);

create index if not exists vault_memberships_user_idx
  on public.vault_memberships(auth_user_id,vault_id)
  where revoked_at is null;
create index if not exists vault_memberships_account_identity_idx
  on public.vault_memberships(account_id,auth_user_id);

insert into public.vault_memberships(vault_id,account_id,auth_user_id,role)
select v.id,v.account_id,v.auth_user_id,'owner'
from public.vault_cloud_vaults v
on conflict (vault_id,account_id) do update
set role='owner',revoked_at=null,updated_at=now();

create or replace function vault_private.ensure_vault_owner_membership()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  insert into public.vault_memberships(vault_id,account_id,auth_user_id,role)
  values(new.id,new.account_id,new.auth_user_id,'owner')
  on conflict (vault_id,account_id) do update
  set role='owner',revoked_at=null,updated_at=now();
  return new;
end;
$$;

drop trigger if exists vault_cloud_vault_owner_membership on public.vault_cloud_vaults;
create trigger vault_cloud_vault_owner_membership
after insert on public.vault_cloud_vaults
for each row execute function vault_private.ensure_vault_owner_membership();

create or replace function vault_private.guard_vault_membership()
returns trigger
language plpgsql
set search_path=''
as $$
declare
  v_owner_account uuid;
  v_owner_user uuid;
begin
  if tg_op='UPDATE' and (
    new.vault_id<>old.vault_id
    or new.account_id<>old.account_id
    or new.auth_user_id<>old.auth_user_id
    or new.created_at<>old.created_at
  ) then
    raise exception 'membership identity fields cannot change';
  end if;

  select v.account_id,v.auth_user_id
  into v_owner_account,v_owner_user
  from public.vault_cloud_vaults v
  where v.id=new.vault_id;

  if new.role='owner' and (new.account_id<>v_owner_account or new.auth_user_id<>v_owner_user) then
    raise exception 'only the canonical Vault owner may have owner role';
  end if;
  if new.account_id=v_owner_account or new.auth_user_id=v_owner_user then
    if new.role<>'owner' or new.revoked_at is not null then
      raise exception 'the canonical Vault owner cannot be demoted or revoked';
    end if;
  end if;
  new.updated_at:=now();
  return new;
end;
$$;

drop trigger if exists vault_memberships_guard on public.vault_memberships;
create trigger vault_memberships_guard
before insert or update on public.vault_memberships
for each row execute function vault_private.guard_vault_membership();

alter table public.vault_memberships enable row level security;
revoke all on public.vault_memberships from anon,authenticated;
grant select on public.vault_memberships to authenticated;

drop policy if exists vault_memberships_select_self on public.vault_memberships;
create policy vault_memberships_select_self
on public.vault_memberships for select
to authenticated
using ((select auth.uid())=auth_user_id);

create table if not exists public.vault_share_invites (
  id uuid primary key default extensions.gen_random_uuid(),
  vault_id uuid not null references public.vault_cloud_vaults(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  role text not null check (role in ('editor','viewer')),
  created_by_auth_user_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz null,
  accepted_by_auth_user_id uuid null,
  revoked_at timestamptz null
);

create index if not exists vault_share_invites_vault_idx
  on public.vault_share_invites(vault_id,created_at desc);

alter table public.vault_share_invites enable row level security;
revoke all on public.vault_share_invites from anon,authenticated;

drop policy if exists vault_share_invites_deny_direct on public.vault_share_invites;
create policy vault_share_invites_deny_direct
on public.vault_share_invites for all
to authenticated
using (false) with check (false);

create or replace function public.vault_accessible_vaults()
returns table(
  id uuid,
  account_id uuid,
  auth_user_id uuid,
  owner_account_id uuid,
  owner_auth_user_id uuid,
  access_role text,
  name text,
  epoch uuid,
  protocol_version smallint,
  created_at timestamptz,
  updated_at timestamptz,
  disabled_at timestamptz
)
language sql
stable
security definer
set search_path=''
as $$
  select
    v.id,m.account_id,m.auth_user_id,v.account_id,v.auth_user_id,m.role,
    v.name,v.epoch,v.protocol_version,v.created_at,v.updated_at,v.disabled_at
  from public.vault_memberships m
  join public.vault_cloud_vaults v on v.id=m.vault_id
  where m.auth_user_id=(select auth.uid())
    and m.revoked_at is null
    and v.disabled_at is null
  order by v.updated_at desc;
$$;

create or replace function public.vault_share_members(p_vault_id uuid)
returns table(
  vault_id uuid,
  account_id uuid,
  auth_user_id uuid,
  role text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_uid uuid:=auth.uid();
begin
  if v_uid is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform 1 from public.vault_cloud_vaults v
  where v.id=p_vault_id and v.auth_user_id=v_uid and v.disabled_at is null;
  if not found then raise exception 'only the Vault owner can list members' using errcode='42501'; end if;

  return query
  select m.vault_id,m.account_id,m.auth_user_id,m.role,m.created_at,m.updated_at
  from public.vault_memberships m
  where m.vault_id=p_vault_id and m.revoked_at is null
  order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end,m.created_at;
end;
$$;

create or replace function public.vault_share_create_invite(
  p_vault_id uuid,
  p_role text,
  p_expires_hours integer default 168
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_uid uuid:=auth.uid();
  v_token text;
  v_expires timestamptz;
begin
  if v_uid is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_role not in ('editor','viewer') then raise exception 'invite role must be editor or viewer'; end if;
  if p_expires_hours is null or p_expires_hours<1 or p_expires_hours>720 then
    raise exception 'invite lifetime must be between 1 and 720 hours';
  end if;
  perform 1 from public.vault_cloud_vaults v
  where v.id=p_vault_id and v.auth_user_id=v_uid and v.disabled_at is null;
  if not found then raise exception 'only the Vault owner can create invitations' using errcode='42501'; end if;

  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  v_expires:=now()+make_interval(hours=>p_expires_hours);
  insert into public.vault_share_invites(
    vault_id,token_hash,role,created_by_auth_user_id,expires_at
  ) values(
    p_vault_id,encode(extensions.digest(v_token,'sha256'),'hex'),p_role,v_uid,v_expires
  );
  return jsonb_build_object(
    'vaultId',p_vault_id::text,
    'role',p_role,
    'token',v_token,
    'expiresAt',v_expires::text
  );
end;
$$;

create or replace function public.vault_share_accept_invite(p_token text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_uid uuid:=auth.uid();
  v_account_id uuid;
  v_invite public.vault_share_invites%rowtype;
  v_vault public.vault_cloud_vaults%rowtype;
begin
  if v_uid is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_token !~ '^[0-9a-f]{64}$' then raise exception 'invalid invitation token'; end if;
  select a.id into v_account_id from public.vault_accounts a where a.auth_user_id=v_uid;
  if v_account_id is null then raise exception 'cloud account mapping is missing'; end if;

  select * into v_invite
  from public.vault_share_invites i
  where i.token_hash=encode(extensions.digest(p_token,'sha256'),'hex')
    and i.accepted_at is null
    and i.revoked_at is null
  for update;
  if not found then raise exception 'invitation is invalid or already used' using errcode='42501'; end if;
  if v_invite.expires_at<=now() then raise exception 'invitation has expired' using errcode='42501'; end if;

  select * into v_vault from public.vault_cloud_vaults v
  where v.id=v_invite.vault_id and v.disabled_at is null;
  if not found then raise exception 'shared Vault is unavailable' using errcode='42501'; end if;
  if v_vault.auth_user_id=v_uid then raise exception 'the Vault owner already has access'; end if;

  insert into public.vault_memberships(vault_id,account_id,auth_user_id,role,revoked_at)
  values(v_vault.id,v_account_id,v_uid,v_invite.role,null)
  on conflict (vault_id,account_id) do update
  set role=excluded.role,revoked_at=null,updated_at=now();

  update public.vault_share_invites
  set accepted_at=now(),accepted_by_auth_user_id=v_uid
  where id=v_invite.id;

  update public.vault_cloud_vaults set updated_at=now() where id=v_vault.id;

  return jsonb_build_object(
    'id',v_vault.id::text,
    'account_id',v_account_id::text,
    'auth_user_id',v_uid::text,
    'owner_account_id',v_vault.account_id::text,
    'owner_auth_user_id',v_vault.auth_user_id::text,
    'access_role',v_invite.role,
    'name',v_vault.name,
    'epoch',v_vault.epoch::text,
    'protocol_version',v_vault.protocol_version,
    'created_at',v_vault.created_at::text,
    'updated_at',now()::text,
    'disabled_at',case when v_vault.disabled_at is null then null else v_vault.disabled_at::text end
  );
end;
$$;

create or replace function public.vault_share_set_member_role(
  p_vault_id uuid,
  p_member_auth_user_id uuid,
  p_role text
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  v_uid uuid:=auth.uid();
  v_owner_uid uuid;
begin
  if v_uid is null then raise exception 'authentication required' using errcode='42501'; end if;
  select v.auth_user_id into v_owner_uid
  from public.vault_cloud_vaults v
  where v.id=p_vault_id and v.disabled_at is null;
  if v_owner_uid is null or v_owner_uid<>v_uid then
    raise exception 'only the Vault owner can manage members' using errcode='42501';
  end if;
  if p_member_auth_user_id=v_owner_uid then raise exception 'the Vault owner cannot be changed'; end if;
  if p_role is not null and p_role not in ('editor','viewer') then raise exception 'member role must be editor or viewer'; end if;

  if p_role is null then
    update public.vault_memberships
    set revoked_at=now(),updated_at=now()
    where vault_id=p_vault_id and auth_user_id=p_member_auth_user_id and role<>'owner' and revoked_at is null;
  else
    update public.vault_memberships
    set role=p_role,revoked_at=null,updated_at=now()
    where vault_id=p_vault_id and auth_user_id=p_member_auth_user_id and role<>'owner';
  end if;
  if not found then raise exception 'shared Vault member was not found'; end if;
  update public.vault_cloud_vaults set updated_at=now() where id=p_vault_id;
end;
$$;

revoke all on function public.vault_accessible_vaults() from public,anon;
revoke all on function public.vault_share_members(uuid) from public,anon;
revoke all on function public.vault_share_create_invite(uuid,text,integer) from public,anon;
revoke all on function public.vault_share_accept_invite(text) from public,anon;
revoke all on function public.vault_share_set_member_role(uuid,uuid,text) from public,anon;
grant execute on function public.vault_accessible_vaults() to authenticated;
grant execute on function public.vault_share_members(uuid) to authenticated;
grant execute on function public.vault_share_create_invite(uuid,text,integer) to authenticated;
grant execute on function public.vault_share_accept_invite(text) to authenticated;
grant execute on function public.vault_share_set_member_role(uuid,uuid,text) to authenticated;

-- Canonical sync rows remain owned by the Vault owner. Actor fields preserve
-- collaborator provenance without making collaborator account deletion own or
-- cascade canonical history.
alter table public.vault_sync_entries
  drop constraint if exists vault_sync_entries_device_fk;
alter table public.vault_sync_operations
  drop constraint if exists vault_sync_operations_device_fk;
alter table public.vault_sync_events
  drop constraint if exists vault_sync_events_device_fk;

alter table public.vault_sync_entries
  add column if not exists updated_by_account_id uuid,
  add column if not exists updated_by_auth_user_id uuid;
alter table public.vault_sync_operations
  add column if not exists actor_account_id uuid,
  add column if not exists actor_auth_user_id uuid;
alter table public.vault_sync_events
  add column if not exists actor_account_id uuid,
  add column if not exists actor_auth_user_id uuid;

update public.vault_sync_entries
set updated_by_account_id=account_id,updated_by_auth_user_id=auth_user_id
where updated_by_account_id is null or updated_by_auth_user_id is null;
update public.vault_sync_operations
set actor_account_id=account_id,actor_auth_user_id=auth_user_id
where actor_account_id is null or actor_auth_user_id is null;
update public.vault_sync_events
set actor_account_id=account_id,actor_auth_user_id=auth_user_id
where actor_account_id is null or actor_auth_user_id is null;

alter table public.vault_sync_entries
  alter column updated_by_account_id set not null,
  alter column updated_by_auth_user_id set not null;
alter table public.vault_sync_operations
  alter column actor_account_id set not null,
  alter column actor_auth_user_id set not null;
alter table public.vault_sync_events
  alter column actor_account_id set not null,
  alter column actor_auth_user_id set not null;

create index if not exists vault_sync_operations_actor_idx
  on public.vault_sync_operations(actor_auth_user_id,created_at desc);
create index if not exists vault_sync_events_actor_idx
  on public.vault_sync_events(actor_auth_user_id,created_at desc);

create or replace function public.vault_sync_pull(
  p_vault_id uuid,
  p_epoch uuid,
  p_after text,
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_after bigint;
  v_high bigint;
  v_through bigint;
  v_events jsonb;
begin
  if v_uid is null then raise exception 'authentication required'; end if;
  if p_after !~ '^(0|[1-9][0-9]*)$' or char_length(p_after) > 19 then
    raise exception 'invalid synchronization cursor';
  end if;
  v_after := p_after::bigint;
  if v_after < 0 or v_after > 9223372036854775807 then raise exception 'invalid synchronization cursor'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then raise exception 'invalid synchronization page size'; end if;

  perform 1
  from public.vault_cloud_vaults v
  join public.vault_memberships m
    on m.vault_id=v.id
   and m.auth_user_id=v_uid
   and m.revoked_at is null
  where v.id=p_vault_id
    and v.epoch=p_epoch
    and v.protocol_version=1
    and v.disabled_at is null;
  if not found then
    raise exception 'cloud Vault membership/epoch mismatch' using errcode='42501';
  end if;

  select greatest(coalesce(c.next_sequence-1,0),0)
  into v_high
  from public.vault_sync_counters c
  where c.vault_id=p_vault_id;
  v_high := coalesce(v_high,0);

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'sequence', q.sequence::text,
      'operationId', q.operation_id::text,
      'entryId', q.entry_id::text,
      'revision', q.revision,
      'kind', q.kind,
      'deviceId', q.device_id::text,
      'snapshot', q.snapshot
    ) order by q.sequence),'[]'::jsonb),
    coalesce(max(q.sequence),v_after)
  into v_events,v_through
  from (
    select e.sequence,e.operation_id,e.entry_id,e.revision,e.kind,e.device_id,e.snapshot
    from public.vault_sync_events e
    where e.vault_id=p_vault_id and e.sequence>v_after
    order by e.sequence
    limit p_limit
  ) q;

  return jsonb_build_object(
    'protocolVersion',1,
    'vaultId',p_vault_id::text,
    'epoch',p_epoch::text,
    'after',v_after::text,
    'through',v_through::text,
    'highWatermark',v_high::text,
    'events',v_events
  );
end;
$$;

create or replace function public.vault_sync_push(
  p_wire jsonb,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_account_id uuid;
  v_actor_account_id uuid;
  v_owner_auth_user_id uuid;
  v_access_role text;
  v_vault_id uuid;
  v_operation_id uuid;
  v_device_id uuid;
  v_owner_id uuid;
  v_existing public.vault_sync_operations%rowtype;
  v_mutation jsonb;
  v_kind text;
  v_entry_id uuid;
  v_parent_id uuid;
  v_name text;
  v_entry_kind text;
  v_base_revision integer;
  v_entry public.vault_sync_entries%rowtype;
  v_collision public.vault_sync_entries%rowtype;
  v_snapshot jsonb;
  v_snapshots jsonb := '[]'::jsonb;
  v_sequence bigint;
  v_through bigint := 0;
  v_blob_sha text;
  v_blob_mime text;
  v_blob_size bigint;
  v_blob_path text;
begin
  if v_uid is null then raise exception 'authentication required'; end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'invalid operation digest'; end if;
  if jsonb_typeof(p_wire) <> 'object' or (p_wire->>'protocolVersion')::integer <> 1 then raise exception 'invalid operation protocol'; end if;

  begin
    v_operation_id := (p_wire->>'id')::uuid;
    v_vault_id := (p_wire->>'vaultId')::uuid;
    v_device_id := (p_wire->>'deviceId')::uuid;
    v_owner_id := (p_wire->>'ownerId')::uuid;
  exception when others then
    raise exception 'invalid operation identity';
  end;
  if v_owner_id<>v_uid then raise exception 'operation owner mismatch'; end if;
  if jsonb_typeof(p_wire->'mutations') <> 'array'
    or jsonb_array_length(p_wire->'mutations') < 1
    or jsonb_array_length(p_wire->'mutations') > 1000 then
    raise exception 'invalid operation mutation list';
  end if;

  select a.id into v_actor_account_id
  from public.vault_accounts a
  where a.auth_user_id=v_uid;
  if v_actor_account_id is null then raise exception 'cloud account mapping is missing'; end if;

  select v.account_id,v.auth_user_id,m.role
  into v_account_id,v_owner_auth_user_id,v_access_role
  from public.vault_cloud_vaults v
  join public.vault_memberships m
    on m.vault_id=v.id
   and m.account_id=v_actor_account_id
   and m.auth_user_id=v_uid
   and m.revoked_at is null
  where v.id=v_vault_id
    and v.protocol_version=1
    and v.disabled_at is null;
  if not found or v_access_role not in ('owner','editor') then
    raise exception 'cloud Vault is read-only or unavailable' using errcode='42501';
  end if;

  perform 1
  from public.vault_cloud_devices d
  where d.account_id=v_actor_account_id
    and d.id=v_device_id
    and d.auth_user_id=v_uid
    and d.revoked_at is null;
  if not found then raise exception 'device is not authorized for synchronization' using errcode='42501'; end if;

  select * into v_existing
  from public.vault_sync_operations o
  where o.vault_id=v_vault_id and o.operation_id=v_operation_id
  for update;
  if found then
    if v_existing.sha256<>p_sha256 or v_existing.wire<>p_wire then
      raise exception 'operation id was reused with different bytes';
    end if;
    if v_existing.result is null then raise exception 'operation result is unavailable'; end if;
    return v_existing.result;
  end if;

  insert into public.vault_sync_counters(vault_id,account_id,auth_user_id,next_sequence)
  values(v_vault_id,v_account_id,v_owner_auth_user_id,1)
  on conflict (vault_id) do nothing;

  perform 1 from public.vault_sync_counters c where c.vault_id=v_vault_id for update;

  insert into public.vault_sync_operations(
    vault_id,operation_id,account_id,auth_user_id,device_id,actor_account_id,actor_auth_user_id,sha256,wire
  ) values(
    v_vault_id,v_operation_id,v_account_id,v_owner_auth_user_id,v_device_id,v_actor_account_id,v_uid,p_sha256,p_wire
  );

  for v_mutation in select value from jsonb_array_elements(p_wire->'mutations')
  loop
    v_kind := v_mutation->>'kind';
    begin v_entry_id := (v_mutation->>'entryId')::uuid;
    exception when others then raise exception 'invalid mutation entry identity'; end;

    if v_kind='create' then
      v_entry_kind:=v_mutation->>'entryKind';
      v_name:=v_mutation->>'name';
      if v_entry_kind not in ('directory','markdown','attachment')
        or not vault_private.valid_sync_name(v_name) then
        raise exception 'invalid create mutation';
      end if;
      v_parent_id:=null;
      if v_mutation->>'parentId' is not null then
        begin v_parent_id:=(v_mutation->>'parentId')::uuid;
        exception when others then raise exception 'invalid parent identity'; end;
      end if;
      if v_parent_id is not null then
        perform 1 from public.vault_sync_entries p
        where p.vault_id=v_vault_id and p.entry_id=v_parent_id and p.kind='directory' and p.deleted_at is null;
        if not found then raise exception 'parent folder is unavailable'; end if;
      end if;
      select * into v_entry from public.vault_sync_entries e
      where e.vault_id=v_vault_id and e.entry_id=v_entry_id;
      if found then
        perform vault_private.raise_sync_conflict('exists',v_entry_id,vault_private.sync_snapshot(v_entry));
      end if;
      select * into v_collision from public.vault_sync_entries e
      where e.vault_id=v_vault_id and e.deleted_at is null
        and e.parent_id is not distinct from v_parent_id
        and translate(e.name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
          = translate(v_name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
      limit 1;
      if found then
        perform vault_private.raise_sync_conflict('path',v_entry_id,vault_private.sync_snapshot(v_collision));
      end if;

      v_blob_sha:=null; v_blob_mime:=null; v_blob_size:=null;
      if v_entry_kind='attachment' then
        v_blob_sha:=v_mutation#>>'{attachment,sha256}';
        v_blob_mime:=v_mutation#>>'{attachment,mimeType}';
        begin v_blob_size:=(v_mutation#>>'{attachment,size}')::bigint;
        exception when others then raise exception 'invalid attachment size'; end;
        if v_blob_sha !~ '^[0-9a-f]{64}$' or v_blob_mime is null or char_length(v_blob_mime) not between 1 and 200
          or v_blob_size<0 or v_blob_size>134217728 then raise exception 'invalid attachment metadata'; end if;
        v_blob_path:=v_owner_auth_user_id::text||'/'||v_vault_id::text||'/'||v_blob_sha;
        perform 1 from storage.objects o where o.bucket_id='vault-sync' and o.name=v_blob_path;
        if not found then raise exception 'attachment blob must be uploaded before its create operation'; end if;
      end if;

      if v_entry_kind='markdown' and octet_length(coalesce(v_mutation->>'text','')) > 16777216 then
        raise exception 'Markdown payload exceeds 16 MB sync limit';
      end if;

      insert into public.vault_sync_entries(
        vault_id,entry_id,account_id,auth_user_id,parent_id,name,kind,revision,deleted_at,
        markdown_text,blob_sha256,blob_mime_type,blob_size,updated_at,updated_by_device,
        updated_by_account_id,updated_by_auth_user_id
      ) values(
        v_vault_id,v_entry_id,v_account_id,v_owner_auth_user_id,v_parent_id,v_name,v_entry_kind,1,null,
        case when v_entry_kind='markdown' then coalesce(v_mutation->>'text','') else null end,
        v_blob_sha,v_blob_mime,v_blob_size,now(),v_device_id,v_actor_account_id,v_uid
      )
      returning * into v_entry;

    elsif v_kind in ('write','move','trash','restore') then
      begin v_base_revision:=(v_mutation->>'baseRevision')::integer;
      exception when others then raise exception 'invalid base revision'; end;
      select * into v_entry
      from public.vault_sync_entries e
      where e.vault_id=v_vault_id and e.entry_id=v_entry_id
      for update;
      if not found then
        perform vault_private.raise_sync_conflict('revision',v_entry_id,null);
      end if;
      if v_entry.revision<>v_base_revision then
        perform vault_private.raise_sync_conflict('revision',v_entry_id,vault_private.sync_snapshot(v_entry));
      end if;

      if v_kind='write' then
        if v_entry.kind<>'markdown' or jsonb_typeof(v_mutation->'text')<>'string' then raise exception 'invalid write mutation'; end if;
        if octet_length(v_mutation->>'text') > 16777216 then raise exception 'Markdown payload exceeds 16 MB sync limit'; end if;
        update public.vault_sync_entries
        set markdown_text=v_mutation->>'text',revision=revision+1,updated_at=now(),updated_by_device=v_device_id,updated_by_account_id=v_actor_account_id,updated_by_auth_user_id=v_uid
        where vault_id=v_vault_id and entry_id=v_entry_id
        returning * into v_entry;

      elsif v_kind='move' then
        v_name:=v_mutation->>'name';
        if not vault_private.valid_sync_name(v_name) then raise exception 'invalid move name'; end if;
        v_parent_id:=null;
        if v_mutation->>'parentId' is not null then
          begin v_parent_id:=(v_mutation->>'parentId')::uuid;
          exception when others then raise exception 'invalid parent identity'; end;
        end if;
        if v_parent_id=v_entry_id then raise exception 'entry cannot parent itself'; end if;
        if v_parent_id is not null then
          perform 1 from public.vault_sync_entries p
          where p.vault_id=v_vault_id and p.entry_id=v_parent_id and p.kind='directory' and p.deleted_at is null;
          if not found then raise exception 'parent folder is unavailable'; end if;
        end if;
        if v_entry.kind='directory' and v_parent_id is not null and exists (
          with recursive ancestors(entry_id,parent_id) as (
            select e.entry_id,e.parent_id
            from public.vault_sync_entries e
            where e.vault_id=v_vault_id and e.entry_id=v_parent_id
            union
            select e.entry_id,e.parent_id
            from public.vault_sync_entries e
            join ancestors a on e.entry_id=a.parent_id
            where e.vault_id=v_vault_id
          )
          select 1 from ancestors where entry_id=v_entry_id
        ) then
          raise exception 'folder move would create a cycle';
        end if;
        if v_entry.deleted_at is null then
          select * into v_collision from public.vault_sync_entries e
          where e.vault_id=v_vault_id and e.deleted_at is null and e.entry_id<>v_entry_id
            and e.parent_id is not distinct from v_parent_id
            and translate(e.name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
              = translate(v_name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
          limit 1;
          if found then
            perform vault_private.raise_sync_conflict('path',v_entry_id,vault_private.sync_snapshot(v_collision));
          end if;
        end if;
        update public.vault_sync_entries
        set parent_id=v_parent_id,name=v_name,revision=revision+1,updated_at=now(),updated_by_device=v_device_id,updated_by_account_id=v_actor_account_id,updated_by_auth_user_id=v_uid
        where vault_id=v_vault_id and entry_id=v_entry_id
        returning * into v_entry;

      elsif v_kind='trash' then
        update public.vault_sync_entries
        set deleted_at=coalesce(deleted_at,now()),revision=revision+1,updated_at=now(),updated_by_device=v_device_id,updated_by_account_id=v_actor_account_id,updated_by_auth_user_id=v_uid
        where vault_id=v_vault_id and entry_id=v_entry_id
        returning * into v_entry;

      else
        if v_entry.deleted_at is null then
          update public.vault_sync_entries
          set revision=revision+1,updated_at=now(),updated_by_device=v_device_id,updated_by_account_id=v_actor_account_id,updated_by_auth_user_id=v_uid
          where vault_id=v_vault_id and entry_id=v_entry_id
          returning * into v_entry;
        else
          if v_entry.parent_id is not null then
            perform 1 from public.vault_sync_entries p
            where p.vault_id=v_vault_id and p.entry_id=v_entry.parent_id and p.kind='directory' and p.deleted_at is null;
            if not found then raise exception 'restore parent folder is unavailable'; end if;
          end if;
          select * into v_collision from public.vault_sync_entries e
          where e.vault_id=v_vault_id and e.deleted_at is null and e.entry_id<>v_entry_id
            and e.parent_id is not distinct from v_entry.parent_id
            and translate(e.name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
              = translate(v_entry.name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
          limit 1;
          if found then
            perform vault_private.raise_sync_conflict('path',v_entry_id,vault_private.sync_snapshot(v_collision));
          end if;
          update public.vault_sync_entries
          set deleted_at=null,revision=revision+1,updated_at=now(),updated_by_device=v_device_id,updated_by_account_id=v_actor_account_id,updated_by_auth_user_id=v_uid
          where vault_id=v_vault_id and entry_id=v_entry_id
          returning * into v_entry;
        end if;
      end if;
    else
      raise exception 'unsupported mutation kind';
    end if;

    v_snapshot:=vault_private.sync_snapshot(v_entry);
    select next_sequence into v_sequence
    from public.vault_sync_counters
    where vault_id=v_vault_id
    for update;
    update public.vault_sync_counters
    set next_sequence=next_sequence+1
    where vault_id=v_vault_id;

    insert into public.vault_sync_events(
      vault_id,sequence,account_id,auth_user_id,operation_id,entry_id,revision,kind,device_id,
      actor_account_id,actor_auth_user_id,snapshot
    ) values(
      v_vault_id,v_sequence,v_account_id,v_owner_auth_user_id,v_operation_id,v_entry.entry_id,v_entry.revision,v_kind,v_device_id,
      v_actor_account_id,v_uid,v_snapshot
    );
    v_through:=v_sequence;
    v_snapshots:=v_snapshots||jsonb_build_array(v_snapshot);
  end loop;

  update public.vault_cloud_vaults
  set updated_at=now()
  where id=v_vault_id;

  v_snapshot:=jsonb_build_object(
    'status','ok',
    'operationId',v_operation_id::text,
    'through',v_through::text,
    'snapshots',v_snapshots
  );
  update public.vault_sync_operations
  set result=v_snapshot
  where vault_id=v_vault_id and operation_id=v_operation_id;
  return v_snapshot;
end;
$$;


revoke all on function public.vault_sync_pull(uuid,uuid,text,integer) from public,anon;
revoke all on function public.vault_sync_push(jsonb,text) from public,anon;
grant execute on function public.vault_sync_pull(uuid,uuid,text,integer) to authenticated;
grant execute on function public.vault_sync_push(jsonb,text) to authenticated;

-- Shared attachments remain under the canonical owner's prefix so membership
-- changes never move or duplicate object bytes.
drop policy if exists vault_sync_objects_select on storage.objects;
create policy vault_sync_objects_select
on storage.objects for select
to authenticated
using (
  bucket_id='vault-sync'
  and exists (
    select 1
    from public.vault_cloud_vaults v
    join public.vault_memberships m
      on m.vault_id=v.id
     and m.auth_user_id=(select auth.uid())
     and m.revoked_at is null
    where v.id::text=(storage.foldername(storage.objects.name))[2]
      and v.auth_user_id::text=(storage.foldername(storage.objects.name))[1]
      and v.disabled_at is null
  )
);

drop policy if exists vault_sync_objects_insert on storage.objects;
create policy vault_sync_objects_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id='vault-sync'
  and exists (
    select 1
    from public.vault_cloud_vaults v
    join public.vault_memberships m
      on m.vault_id=v.id
     and m.auth_user_id=(select auth.uid())
     and m.revoked_at is null
     and m.role in ('owner','editor')
    where v.id::text=(storage.foldername(storage.objects.name))[2]
      and v.auth_user_id::text=(storage.foldername(storage.objects.name))[1]
      and v.disabled_at is null
  )
);

drop policy if exists vault_realtime_sync_read on realtime.messages;
create policy vault_realtime_sync_read
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension='broadcast'
  and split_part((select realtime.topic()),':',1)='vault'
  and exists (
    select 1
    from public.vault_cloud_vaults v
    join public.vault_memberships m
      on m.vault_id=v.id
     and m.auth_user_id=(select auth.uid())
     and m.revoked_at is null
    where v.id::text=split_part((select realtime.topic()),':',2)
      and v.epoch::text=split_part((select realtime.topic()),':',3)
      and v.disabled_at is null
  )
);
