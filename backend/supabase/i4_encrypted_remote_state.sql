-- I4 — Encrypted Remote State & PostgreSQL Sync Core
--
-- Canonical Protocol v2 content remains ciphertext-only. These tables live in
-- vault_private and have no direct browser grants. Public RPC wrappers perform
-- authentication, AccountId/Device authorization, CAS validation, operation
-- idempotency and per-Vault serialization.
--
-- I4 deliberately does NOT switch the production browser replication engine to
-- Protocol v2. I5 owns that client cutover.

create schema if not exists vault_private;
revoke all on schema vault_private from public,anon,authenticated;

-- ---------------------------------------------------------------------------
-- Protocol-v1 -> Protocol-v2 clean-break upgrade
-- ---------------------------------------------------------------------------

alter table public.vault_cloud_vaults
  drop constraint if exists vault_cloud_vaults_protocol_version_check;

alter table public.vault_cloud_vaults
  add constraint vault_cloud_vaults_protocol_version_check
  check (protocol_version in (1,2));

create or replace function vault_private.guard_vault_update()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if new.id<>old.id
    or new.account_id<>old.account_id
    or new.auth_user_id<>old.auth_user_id
    or new.epoch<>old.epoch
    or new.created_at<>old.created_at then
    raise exception 'immutable cloud Vault identity fields cannot change';
  end if;

  if new.protocol_version<>old.protocol_version then
    if not (
      old.protocol_version=1
      and new.protocol_version=2
      and current_setting('vault.protocol_upgrade',true)='2'
    ) then
      raise exception 'cloud Vault protocol changes require the controlled upgrade RPC';
    end if;
  end if;

  if old.disabled_at is not null and new.disabled_at is null then
    raise exception 'disabled cloud Vaults cannot be restored implicitly';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Private encrypted replication state
-- ---------------------------------------------------------------------------

create table if not exists vault_private.sync_v2_vault_state (
  vault_id uuid not null,
  account_id uuid not null,
  epoch uuid not null,
  next_sequence bigint not null default 1 check(next_sequence>=1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(vault_id,account_id),
  constraint sync_v2_vault_state_key_state_fk
    foreign key(vault_id,account_id)
    references vault_private.vault_key_state(vault_id,account_id)
    on delete cascade
);

create table if not exists vault_private.blob_refs (
  vault_id uuid not null,
  account_id uuid not null,
  blob_id text not null check(blob_id ~ '^[A-Za-z0-9_-]{43}$'),
  key_generation integer not null check(key_generation>=1),
  state text not null check(state in ('pending','ready','orphaned')),
  ciphertext_size bigint null check(ciphertext_size is null or ciphertext_size>=0),
  created_at timestamptz not null default now(),
  ready_at timestamptz null,
  primary key(vault_id,account_id,blob_id,key_generation),
  constraint blob_refs_vault_state_fk
    foreign key(vault_id,account_id)
    references vault_private.sync_v2_vault_state(vault_id,account_id)
    on delete cascade
);

create table if not exists vault_private.entity_heads (
  vault_id uuid not null,
  account_id uuid not null,
  entity_id uuid not null,
  entity_type text not null check(entity_type in (
    'vault','note','folder','tag','property-definition','task','event',
    'project','person','attachment','capture','collection','link'
  )),
  remote_revision bigint not null check(remote_revision>=1),
  sequence bigint not null check(sequence>=1),
  parent_id uuid null,
  name_token text null check(name_token is null or name_token ~ '^[A-Za-z0-9_-]{43}$'),
  deleted boolean not null,
  blob_id text null check(blob_id is null or blob_id ~ '^[A-Za-z0-9_-]{43}$'),
  schema_version integer not null check(schema_version>=1),
  encryption_version smallint not null check(encryption_version=1),
  key_generation integer not null check(key_generation>=1),
  algorithm text not null check(algorithm='A256GCM'),
  nonce text not null check(nonce ~ '^[A-Za-z0-9_-]{16}$'),
  ciphertext text not null check(ciphertext ~ '^[A-Za-z0-9_-]+$' and char_length(ciphertext) between 22 and 25165824),
  operation_id uuid not null,
  updated_by_device uuid not null,
  updated_at timestamptz not null default now(),
  primary key(vault_id,entity_id),
  constraint entity_heads_vault_state_fk
    foreign key(vault_id,account_id)
    references vault_private.sync_v2_vault_state(vault_id,account_id)
    on delete cascade
);

create unique index if not exists entity_heads_active_name_token_idx
  on vault_private.entity_heads(vault_id,parent_id,name_token)
  nulls not distinct
  where deleted=false and name_token is not null;

create index if not exists entity_heads_vault_sequence_idx
  on vault_private.entity_heads(vault_id,sequence);
create index if not exists entity_heads_parent_idx
  on vault_private.entity_heads(vault_id,parent_id)
  where deleted=false;
create index if not exists entity_heads_blob_idx
  on vault_private.entity_heads(vault_id,blob_id)
  where blob_id is not null;

create table if not exists vault_private.entity_versions (
  vault_id uuid not null,
  account_id uuid not null,
  entity_id uuid not null,
  entity_type text not null check(entity_type in (
    'vault','note','folder','tag','property-definition','task','event',
    'project','person','attachment','capture','collection','link'
  )),
  remote_revision bigint not null check(remote_revision>=1),
  sequence bigint not null check(sequence>=1),
  parent_id uuid null,
  name_token text null check(name_token is null or name_token ~ '^[A-Za-z0-9_-]{43}$'),
  deleted boolean not null,
  blob_id text null check(blob_id is null or blob_id ~ '^[A-Za-z0-9_-]{43}$'),
  schema_version integer not null check(schema_version>=1),
  encryption_version smallint not null check(encryption_version=1),
  key_generation integer not null check(key_generation>=1),
  algorithm text not null check(algorithm='A256GCM'),
  nonce text not null check(nonce ~ '^[A-Za-z0-9_-]{16}$'),
  ciphertext text not null check(ciphertext ~ '^[A-Za-z0-9_-]+$' and char_length(ciphertext) between 22 and 25165824),
  operation_id uuid not null,
  updated_by_device uuid not null,
  created_at timestamptz not null default now(),
  primary key(vault_id,entity_id,remote_revision),
  constraint entity_versions_vault_state_fk
    foreign key(vault_id,account_id)
    references vault_private.sync_v2_vault_state(vault_id,account_id)
    on delete cascade
);

create unique index if not exists entity_versions_sequence_idx
  on vault_private.entity_versions(vault_id,sequence);
create index if not exists entity_versions_bootstrap_idx
  on vault_private.entity_versions(vault_id,entity_id,sequence desc);

create table if not exists vault_private.accepted_operations (
  vault_id uuid not null,
  account_id uuid not null,
  operation_id uuid not null,
  device_id uuid not null,
  protocol_version smallint not null check(protocol_version=2),
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  wire_text text not null,
  mutation_count integer not null check(mutation_count between 1 and 1000),
  first_sequence bigint not null check(first_sequence>=1),
  last_sequence bigint not null check(last_sequence>=first_sequence),
  result jsonb not null,
  accepted_at timestamptz not null default now(),
  primary key(vault_id,operation_id),
  constraint accepted_operations_vault_state_fk
    foreign key(vault_id,account_id)
    references vault_private.sync_v2_vault_state(vault_id,account_id)
    on delete cascade
);

create index if not exists accepted_operations_device_idx
  on vault_private.accepted_operations(vault_id,device_id,accepted_at desc);

create table if not exists vault_private.sync_events (
  vault_id uuid not null,
  account_id uuid not null,
  sequence bigint not null check(sequence>=1),
  operation_id uuid not null,
  entity_id uuid not null,
  entity_type text not null,
  remote_revision bigint not null check(remote_revision>=1),
  kind text not null check(kind='put'),
  device_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(vault_id,sequence),
  constraint sync_events_vault_state_fk
    foreign key(vault_id,account_id)
    references vault_private.sync_v2_vault_state(vault_id,account_id)
    on delete cascade,
  constraint sync_events_version_fk
    foreign key(vault_id,entity_id,remote_revision)
    references vault_private.entity_versions(vault_id,entity_id,remote_revision)
    on delete restrict
);

create index if not exists sync_events_operation_idx
  on vault_private.sync_events(vault_id,operation_id);
create index if not exists sync_events_entity_idx
  on vault_private.sync_events(vault_id,entity_id,sequence desc);

create table if not exists vault_private.device_vault_state (
  vault_id uuid not null,
  account_id uuid not null,
  device_id uuid not null,
  last_acked_sequence bigint not null default 0 check(last_acked_sequence>=0),
  last_seen_at timestamptz not null default now(),
  primary key(vault_id,account_id,device_id),
  constraint device_vault_state_vault_state_fk
    foreign key(vault_id,account_id)
    references vault_private.sync_v2_vault_state(vault_id,account_id)
    on delete cascade
);

alter table vault_private.sync_v2_vault_state enable row level security;
alter table vault_private.blob_refs enable row level security;
alter table vault_private.entity_heads enable row level security;
alter table vault_private.entity_versions enable row level security;
alter table vault_private.accepted_operations enable row level security;
alter table vault_private.sync_events enable row level security;
alter table vault_private.device_vault_state enable row level security;

revoke all on vault_private.sync_v2_vault_state from public,anon,authenticated;
revoke all on vault_private.blob_refs from public,anon,authenticated;
revoke all on vault_private.entity_heads from public,anon,authenticated;
revoke all on vault_private.entity_versions from public,anon,authenticated;
revoke all on vault_private.accepted_operations from public,anon,authenticated;
revoke all on vault_private.sync_events from public,anon,authenticated;
revoke all on vault_private.device_vault_state from public,anon,authenticated;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function vault_private.jsonb_exact_keys(
  p_value jsonb,
  p_keys text[]
)
returns boolean
language plpgsql
immutable
set search_path=''
as $$
begin
  if jsonb_typeof(p_value)<>'object' then
    return false;
  end if;
  return (
    select count(*)=cardinality(p_keys)
      and bool_and(key_name=any(p_keys))
    from jsonb_object_keys(p_value) as key_name
  );
end;
$$;

create or replace function vault_private.valid_entity_type(p_type text)
returns boolean
language sql
immutable
set search_path=''
as $$
  select p_type=any(array[
    'vault','note','folder','tag','property-definition','task','event',
    'project','person','attachment','capture','collection','link'
  ]::text[]);
$$;

create or replace function vault_private.entity_snapshot_json(
  p_vault_id uuid,
  p_entity_id uuid,
  p_entity_type text,
  p_remote_revision bigint,
  p_sequence bigint,
  p_schema_version integer,
  p_parent_id uuid,
  p_name_token text,
  p_deleted boolean,
  p_blob_id text,
  p_encryption_version smallint,
  p_key_generation integer,
  p_algorithm text,
  p_nonce text,
  p_ciphertext text,
  p_operation_id uuid,
  p_device_id uuid,
  p_updated_at timestamptz
)
returns jsonb
language sql
stable
set search_path=''
as $$
  select jsonb_build_object(
    'entityId',p_entity_id::text,
    'vaultId',p_vault_id::text,
    'entityType',p_entity_type,
    'remoteRevision',p_remote_revision::text,
    'sequence',p_sequence::text,
    'schemaVersion',p_schema_version,
    'structural',jsonb_build_object(
      'parentId',case when p_parent_id is null then null else to_jsonb(p_parent_id::text) end,
      'nameToken',case when p_name_token is null then null else to_jsonb(p_name_token) end,
      'deleted',p_deleted,
      'blobId',case when p_blob_id is null then null else to_jsonb(p_blob_id) end
    ),
    'payload',jsonb_build_object(
      'encryptionVersion',p_encryption_version,
      'keyGeneration',p_key_generation,
      'algorithm',p_algorithm,
      'nonce',p_nonce,
      'ciphertext',p_ciphertext
    ),
    'operationId',p_operation_id::text,
    'updatedByDevice',p_device_id::text,
    'updatedAt',p_updated_at::text
  );
$$;

create or replace function vault_private.entity_head_snapshot_json(
  p_head vault_private.entity_heads
)
returns jsonb
language sql
stable
set search_path=''
as $$
  select vault_private.entity_snapshot_json(
    p_head.vault_id,p_head.entity_id,p_head.entity_type,
    p_head.remote_revision,p_head.sequence,p_head.schema_version,
    p_head.parent_id,p_head.name_token,p_head.deleted,p_head.blob_id,
    p_head.encryption_version,p_head.key_generation,p_head.algorithm,
    p_head.nonce,p_head.ciphertext,p_head.operation_id,
    p_head.updated_by_device,p_head.updated_at
  );
$$;

create or replace function vault_private.entity_version_snapshot_json(
  p_version vault_private.entity_versions
)
returns jsonb
language sql
stable
set search_path=''
as $$
  select vault_private.entity_snapshot_json(
    p_version.vault_id,p_version.entity_id,p_version.entity_type,
    p_version.remote_revision,p_version.sequence,p_version.schema_version,
    p_version.parent_id,p_version.name_token,p_version.deleted,p_version.blob_id,
    p_version.encryption_version,p_version.key_generation,p_version.algorithm,
    p_version.nonce,p_version.ciphertext,p_version.operation_id,
    p_version.updated_by_device,p_version.created_at
  );
$$;

create or replace function vault_private.raise_sync_v2_conflict(
  p_reason text,
  p_entity_id uuid,
  p_current jsonb
)
returns void
language plpgsql
set search_path=''
as $$
begin
  raise sqlstate 'PT409'
    using message=jsonb_build_object(
      'status','conflict',
      'reason',p_reason,
      'entityId',p_entity_id::text,
      'current',p_current
    )::text;
end;
$$;

create or replace function vault_private.require_v2_device(
  p_vault_id uuid,
  p_account_id uuid,
  p_device_id uuid
)
returns integer
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_generation integer;
begin
  if p_account_id is distinct from vault_private.current_account_id() then
    raise exception 'Account mismatch' using errcode='42501';
  end if;

  perform vault_private.require_active_member(p_vault_id,p_account_id);
  perform vault_private.require_authorized_device(
    p_vault_id,p_account_id,p_device_id
  );

  perform 1
  from public.vault_cloud_vaults v
  where v.id=p_vault_id
    and v.account_id=p_account_id
    and v.protocol_version=2
    and v.disabled_at is null;
  if not found then
    raise exception 'Vault is not enabled for Protocol v2' using errcode='42501';
  end if;

  select s.active_generation
  into v_generation
  from vault_private.vault_key_state s
  where s.vault_id=p_vault_id and s.account_id=p_account_id;

  if v_generation is null
    or not exists(
      select 1
      from vault_private.device_vault_key_envelopes e
      where e.vault_id=p_vault_id
        and e.account_id=p_account_id
        and e.device_id=p_device_id
        and e.key_generation=v_generation
    )
    or not exists(
      select 1
      from vault_private.recovery_vault_key_envelopes r
      where r.vault_id=p_vault_id
        and r.account_id=p_account_id
        and r.key_generation=v_generation
    ) then
    raise exception 'Protocol v2 key readiness is incomplete' using errcode='42501';
  end if;

  return v_generation;
end;
$$;

-- ---------------------------------------------------------------------------
-- Controlled clean-break activation
-- ---------------------------------------------------------------------------

create or replace function public.vault_sync_upgrade_v2(
  p_vault_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_vault public.vault_cloud_vaults%rowtype;
  v_ready jsonb;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;

  perform vault_private.require_active_member(p_vault_id,v_account);
  perform vault_private.require_authorized_device(
    p_vault_id,v_account,p_device_id
  );

  select * into v_vault
  from public.vault_cloud_vaults v
  where v.id=p_vault_id
    and v.account_id=v_account
    and v.disabled_at is null
  for update;
  if not found then
    raise exception 'Cloud Vault is unavailable' using errcode='42501';
  end if;

  if v_vault.protocol_version=2 then
    return jsonb_build_object(
      'vaultId',p_vault_id::text,
      'epoch',v_vault.epoch::text,
      'protocolVersion',2
    );
  end if;
  if v_vault.protocol_version<>1 then
    raise exception 'Unsupported source protocol version';
  end if;

  v_ready:=vault_private.readiness_json(p_vault_id,v_account,p_device_id);
  if coalesce((v_ready->>'ready')::boolean,false) is not true then
    raise exception 'Vault key distribution is not ready for Protocol v2';
  end if;

  -- A9 clean break: never reinterpret already-accepted plaintext v1 history.
  if exists(select 1 from public.vault_sync_entries e where e.vault_id=p_vault_id)
    or exists(select 1 from public.vault_sync_operations o where o.vault_id=p_vault_id)
    or exists(select 1 from public.vault_sync_events e where e.vault_id=p_vault_id)
    or exists(
      select 1 from public.vault_sync_counters c
      where c.vault_id=p_vault_id and c.next_sequence>1
    ) then
    raise exception 'Protocol v2 upgrade requires an empty Protocol v1 content history';
  end if;

  perform set_config('vault.protocol_upgrade','2',true);
  update public.vault_cloud_vaults
  set protocol_version=2,updated_at=now()
  where id=p_vault_id and account_id=v_account and protocol_version=1;
  if not found then
    raise exception 'Protocol v2 upgrade raced another Vault change';
  end if;

  insert into vault_private.sync_v2_vault_state(
    vault_id,account_id,epoch,next_sequence
  ) values(
    p_vault_id,v_account,v_vault.epoch,1
  )
  on conflict(vault_id,account_id) do nothing;

  return jsonb_build_object(
    'vaultId',p_vault_id::text,
    'epoch',v_vault.epoch::text,
    'protocolVersion',2
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Protocol v2 push
-- ---------------------------------------------------------------------------

create or replace function public.vault_sync_push_v2(
  p_wire text,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_wire jsonb;
  v_account uuid:=vault_private.current_account_id();
  v_vault_id uuid;
  v_operation_id uuid;
  v_device_id uuid;
  v_active_generation integer;
  v_state vault_private.sync_v2_vault_state%rowtype;
  v_existing_operation vault_private.accepted_operations%rowtype;
  v_mutation jsonb;
  v_structural jsonb;
  v_payload jsonb;
  v_entity_id uuid;
  v_entity_type text;
  v_parent_id uuid;
  v_name_token text;
  v_blob_id text;
  v_deleted boolean;
  v_base_revision bigint;
  v_remote_revision bigint;
  v_schema_version integer;
  v_encryption_version smallint;
  v_key_generation integer;
  v_algorithm text;
  v_nonce text;
  v_ciphertext text;
  v_head vault_private.entity_heads%rowtype;
  v_proposed jsonb:='[]'::jsonb;
  v_item jsonb;
  v_first_sequence bigint;
  v_last_sequence bigint;
  v_next_sequence bigint;
  v_sequence bigint;
  v_now timestamptz;
  v_snapshots jsonb:='[]'::jsonb;
  v_snapshot jsonb;
  v_result jsonb;
  v_conflict_id uuid;
  v_conflict_head vault_private.entity_heads%rowtype;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid Protocol v2 operation digest';
  end if;
  if encode(extensions.digest(convert_to(p_wire,'UTF8'),'sha256'),'hex')<>p_sha256 then
    raise exception 'Protocol v2 wire digest mismatch';
  end if;

  begin
    v_wire:=p_wire::jsonb;
  exception when others then
    raise exception 'Invalid Protocol v2 operation JSON';
  end;

  if not vault_private.jsonb_exact_keys(
      v_wire,
      array['protocolVersion','operationId','accountId','vaultId','deviceId','mutations']
    )
    or jsonb_typeof(v_wire->'protocolVersion')<>'number'
    or (v_wire->>'protocolVersion')::integer<>2
    or jsonb_typeof(v_wire->'operationId')<>'string'
    or jsonb_typeof(v_wire->'accountId')<>'string'
    or jsonb_typeof(v_wire->'vaultId')<>'string'
    or jsonb_typeof(v_wire->'deviceId')<>'string'
    or jsonb_typeof(v_wire->'mutations')<>'array'
    or jsonb_array_length(v_wire->'mutations') not between 1 and 1000 then
    raise exception 'Invalid Protocol v2 operation envelope';
  end if;

  begin
    v_operation_id:=(v_wire->>'operationId')::uuid;
    v_vault_id:=(v_wire->>'vaultId')::uuid;
    v_device_id:=(v_wire->>'deviceId')::uuid;
    if (v_wire->>'accountId')::uuid<>v_account then
      raise exception 'Account mismatch' using errcode='42501';
    end if;
  exception
    when sqlstate '42501' then raise;
    when others then raise exception 'Invalid Protocol v2 operation identity';
  end;

  v_active_generation:=vault_private.require_v2_device(
    v_vault_id,v_account,v_device_id
  );

  select * into v_state
  from vault_private.sync_v2_vault_state s
  where s.vault_id=v_vault_id and s.account_id=v_account
  for update;
  if not found then
    raise exception 'Protocol v2 Vault state is missing';
  end if;

  select * into v_existing_operation
  from vault_private.accepted_operations o
  where o.vault_id=v_vault_id and o.operation_id=v_operation_id;
  if found then
    if v_existing_operation.sha256<>p_sha256
      or v_existing_operation.wire_text<>p_wire
      or v_existing_operation.account_id<>v_account
      or v_existing_operation.device_id<>v_device_id then
      raise exception 'Protocol v2 operation ID was reused with different immutable bytes';
    end if;
    return v_existing_operation.result;
  end if;

  if (
    select count(distinct mutation->>'entityId')
    from jsonb_array_elements(v_wire->'mutations') mutation
  )<>jsonb_array_length(v_wire->'mutations') then
    raise exception 'Protocol v2 operation cannot mutate one entity more than once';
  end if;

  -- Build every proposed final state first. Nothing is written before the
  -- complete operation validates.
  for v_mutation in select value from jsonb_array_elements(v_wire->'mutations')
  loop
    if not vault_private.jsonb_exact_keys(
        v_mutation,
        array['kind','entityId','entityType','baseRemoteRevision','schemaVersion','structural','payload']
      )
      or jsonb_typeof(v_mutation->'kind')<>'string'
      or jsonb_typeof(v_mutation->'entityId')<>'string'
      or jsonb_typeof(v_mutation->'entityType')<>'string'
      or jsonb_typeof(v_mutation->'schemaVersion')<>'number'
      or not (jsonb_typeof(v_mutation->'baseRemoteRevision') in ('null','string'))
      or v_mutation->>'kind'<>'put'
      or not vault_private.valid_entity_type(v_mutation->>'entityType') then
      raise exception 'Invalid Protocol v2 mutation';
    end if;

    begin
      v_entity_id:=(v_mutation->>'entityId')::uuid;
      v_entity_type:=v_mutation->>'entityType';
      v_schema_version:=(v_mutation->>'schemaVersion')::integer;
      if v_schema_version<1 then raise exception 'invalid schema'; end if;
    exception when others then
      raise exception 'Invalid Protocol v2 entity identity or schema version';
    end;

    v_structural:=v_mutation->'structural';
    v_payload:=v_mutation->'payload';

    if not vault_private.jsonb_exact_keys(
        v_structural,array['parentId','nameToken','deleted','blobId']
      )
      or not (jsonb_typeof(v_structural->'parentId') in ('null','string'))
      or not (jsonb_typeof(v_structural->'nameToken') in ('null','string'))
      or jsonb_typeof(v_structural->'deleted')<>'boolean'
      or not (jsonb_typeof(v_structural->'blobId') in ('null','string'))
      or not vault_private.jsonb_exact_keys(
        v_payload,array['encryptionVersion','keyGeneration','algorithm','nonce','ciphertext']
      )
      or jsonb_typeof(v_payload->'encryptionVersion')<>'number'
      or jsonb_typeof(v_payload->'keyGeneration')<>'number'
      or jsonb_typeof(v_payload->'algorithm')<>'string'
      or jsonb_typeof(v_payload->'nonce')<>'string'
      or jsonb_typeof(v_payload->'ciphertext')<>'string' then
      raise exception 'Invalid Protocol v2 encrypted state fields';
    end if;

    begin
      v_parent_id:=case
        when v_structural->'parentId'='null'::jsonb then null
        else (v_structural->>'parentId')::uuid
      end;
    exception when others then
      raise exception 'Invalid Protocol v2 parent identity';
    end;

    v_name_token:=case
      when v_structural->'nameToken'='null'::jsonb then null
      else v_structural->>'nameToken'
    end;
    v_blob_id:=case
      when v_structural->'blobId'='null'::jsonb then null
      else v_structural->>'blobId'
    end;
    v_deleted:=(v_structural->>'deleted')::boolean;

    if (v_name_token is not null and v_name_token !~ '^[A-Za-z0-9_-]{43}$')
      or (v_blob_id is not null and v_blob_id !~ '^[A-Za-z0-9_-]{43}$') then
      raise exception 'Invalid Protocol v2 opaque structural token';
    end if;

    begin
      v_encryption_version:=(v_payload->>'encryptionVersion')::smallint;
      v_key_generation:=(v_payload->>'keyGeneration')::integer;
    exception when others then
      raise exception 'Invalid Protocol v2 encryption version or key generation';
    end;
    v_algorithm:=v_payload->>'algorithm';
    v_nonce:=v_payload->>'nonce';
    v_ciphertext:=v_payload->>'ciphertext';

    if v_encryption_version<>1
      or v_key_generation<>v_active_generation
      or v_algorithm<>'A256GCM'
      or v_nonce !~ '^[A-Za-z0-9_-]{16}$'
      or v_ciphertext !~ '^[A-Za-z0-9_-]+$'
      or char_length(v_ciphertext) not between 22 and 25165824 then
      raise exception 'Invalid or stale Protocol v2 encrypted payload';
    end if;

    if v_entity_type in ('note','folder','attachment') then
      if v_name_token is null then
        raise exception 'Filesystem-like Protocol v2 entities require a NameToken';
      end if;
    elsif v_parent_id is not null or v_name_token is not null then
      raise exception 'Structured Protocol v2 entities cannot expose filesystem parent/name metadata';
    end if;

    if v_entity_type='attachment' then
      if v_blob_id is null then
        raise exception 'Protocol v2 attachment requires a BlobId';
      end if;
      if not exists(
        select 1
        from vault_private.blob_refs b
        where b.vault_id=v_vault_id
          and b.account_id=v_account
          and b.blob_id=v_blob_id
          and b.key_generation=v_key_generation
          and b.state='ready'
      ) then
        perform vault_private.raise_sync_v2_conflict('blob',v_entity_id,null);
      end if;
    elsif v_blob_id is not null then
      raise exception 'Only Protocol v2 attachments may expose a BlobId';
    end if;

    select * into v_head
    from vault_private.entity_heads h
    where h.vault_id=v_vault_id and h.entity_id=v_entity_id;

    if v_mutation->'baseRemoteRevision'='null'::jsonb then
      if found then
        perform vault_private.raise_sync_v2_conflict(
          'exists',v_entity_id,vault_private.entity_head_snapshot_json(v_head)
        );
      end if;
      v_remote_revision:=1;
    else
      begin
        v_base_revision:=(v_mutation->>'baseRemoteRevision')::bigint;
        if v_base_revision<1 then raise exception 'invalid revision'; end if;
      exception when others then
        raise exception 'Invalid Protocol v2 base revision';
      end;

      if not found then
        perform vault_private.raise_sync_v2_conflict('revision',v_entity_id,null);
      end if;
      if v_head.entity_type<>v_entity_type then
        perform vault_private.raise_sync_v2_conflict(
          'type',v_entity_id,vault_private.entity_head_snapshot_json(v_head)
        );
      end if;
      if v_head.remote_revision<>v_base_revision then
        perform vault_private.raise_sync_v2_conflict(
          'revision',v_entity_id,vault_private.entity_head_snapshot_json(v_head)
        );
      end if;
      v_remote_revision:=v_head.remote_revision+1;
    end if;

    v_proposed:=v_proposed||jsonb_build_array(jsonb_build_object(
      'entityId',v_entity_id::text,
      'entityType',v_entity_type,
      'remoteRevision',v_remote_revision::text,
      'schemaVersion',v_schema_version,
      'parentId',case when v_parent_id is null then null else to_jsonb(v_parent_id::text) end,
      'nameToken',case when v_name_token is null then null else to_jsonb(v_name_token) end,
      'deleted',v_deleted,
      'blobId',case when v_blob_id is null then null else to_jsonb(v_blob_id) end,
      'encryptionVersion',v_encryption_version,
      'keyGeneration',v_key_generation,
      'algorithm',v_algorithm,
      'nonce',v_nonce,
      'ciphertext',v_ciphertext
    ));
  end loop;

  -- Validate parent availability against the operation's FINAL state, not
  -- mutation order. This permits child/parent updates in one atomic operation.
  with proposed as (
    select
      (item->>'entityId')::uuid entity_id,
      item->>'entityType' entity_type,
      case when item->'parentId'='null'::jsonb then null else (item->>'parentId')::uuid end parent_id,
      case when item->'nameToken'='null'::jsonb then null else item->>'nameToken' end name_token,
      (item->>'deleted')::boolean deleted
    from jsonb_array_elements(v_proposed) item
  ),
  final_heads as (
    select h.entity_id,h.entity_type,h.parent_id,h.name_token,h.deleted
    from vault_private.entity_heads h
    where h.vault_id=v_vault_id
      and not exists(select 1 from proposed p where p.entity_id=h.entity_id)
    union all
    select p.entity_id,p.entity_type,p.parent_id,p.name_token,p.deleted
    from proposed p
  )
  select p.entity_id
  into v_conflict_id
  from proposed p
  where p.deleted=false
    and p.parent_id is not null
    and (
      p.parent_id=p.entity_id
      or not exists(
        select 1
        from final_heads parent
        where parent.entity_id=p.parent_id
          and parent.entity_type='folder'
          and parent.deleted=false
      )
    )
  limit 1;

  if v_conflict_id is not null then
    select * into v_conflict_head
    from vault_private.entity_heads h
    where h.vault_id=v_vault_id and h.entity_id=v_conflict_id;
    perform vault_private.raise_sync_v2_conflict(
      'parent',v_conflict_id,
      case when found then vault_private.entity_head_snapshot_json(v_conflict_head) else null end
    );
  end if;

  v_conflict_id:=null;

  -- Validate cycles against the same final-state graph.
  with recursive proposed as (
    select
      (item->>'entityId')::uuid entity_id,
      item->>'entityType' entity_type,
      case when item->'parentId'='null'::jsonb then null else (item->>'parentId')::uuid end parent_id,
      (item->>'deleted')::boolean deleted
    from jsonb_array_elements(v_proposed) item
  ),
  final_heads as (
    select h.entity_id,h.entity_type,h.parent_id,h.deleted
    from vault_private.entity_heads h
    where h.vault_id=v_vault_id
      and not exists(select 1 from proposed p where p.entity_id=h.entity_id)
    union all
    select p.entity_id,p.entity_type,p.parent_id,p.deleted
    from proposed p
  ),
  walk(start_id,current_id,path,cycle) as (
    select f.entity_id,f.parent_id,array[f.entity_id],false
    from final_heads f
    where f.deleted=false and f.entity_type in ('folder','note','attachment')
    union all
    select
      w.start_id,
      parent.parent_id,
      w.path||parent.entity_id,
      parent.entity_id=any(w.path)
    from walk w
    join final_heads parent on parent.entity_id=w.current_id
    where w.current_id is not null and w.cycle=false
  )
  select start_id into v_conflict_id
  from walk
  where cycle=true
  limit 1;

  if v_conflict_id is not null then
    select * into v_conflict_head
    from vault_private.entity_heads h
    where h.vault_id=v_vault_id and h.entity_id=v_conflict_id;
    perform vault_private.raise_sync_v2_conflict(
      'cycle',v_conflict_id,
      case when found then vault_private.entity_head_snapshot_json(v_conflict_head) else null end
    );
  end if;

  v_conflict_id:=null;

  -- NameToken collision validation uses the final state and therefore catches
  -- collisions both with existing heads and among entries in this operation.
  with proposed as (
    select
      (item->>'entityId')::uuid entity_id,
      case when item->'parentId'='null'::jsonb then null else (item->>'parentId')::uuid end parent_id,
      case when item->'nameToken'='null'::jsonb then null else item->>'nameToken' end name_token,
      (item->>'deleted')::boolean deleted
    from jsonb_array_elements(v_proposed) item
  ),
  final_heads as (
    select h.entity_id,h.parent_id,h.name_token,h.deleted
    from vault_private.entity_heads h
    where h.vault_id=v_vault_id
      and not exists(select 1 from proposed p where p.entity_id=h.entity_id)
    union all
    select p.entity_id,p.parent_id,p.name_token,p.deleted
    from proposed p
  ),
  collisions as (
    select parent_id,name_token,min(entity_id::text)::uuid entity_id
    from final_heads
    where deleted=false and name_token is not null
    group by parent_id,name_token
    having count(*)>1
  )
  select entity_id into v_conflict_id
  from collisions
  limit 1;

  if v_conflict_id is not null then
    select * into v_conflict_head
    from vault_private.entity_heads h
    where h.vault_id=v_vault_id and h.entity_id=v_conflict_id;
    perform vault_private.raise_sync_v2_conflict(
      'name',v_conflict_id,
      case when found then vault_private.entity_head_snapshot_json(v_conflict_head) else null end
    );
  end if;

  -- All checks passed. The locked Vault sequence now allocates one contiguous
  -- event per mutation.
  v_next_sequence:=v_state.next_sequence;
  v_first_sequence:=v_next_sequence;

  for v_item in select value from jsonb_array_elements(v_proposed)
  loop
    v_entity_id:=(v_item->>'entityId')::uuid;
    v_entity_type:=v_item->>'entityType';
    v_remote_revision:=(v_item->>'remoteRevision')::bigint;
    v_schema_version:=(v_item->>'schemaVersion')::integer;
    v_parent_id:=case when v_item->'parentId'='null'::jsonb then null else (v_item->>'parentId')::uuid end;
    v_name_token:=case when v_item->'nameToken'='null'::jsonb then null else v_item->>'nameToken' end;
    v_deleted:=(v_item->>'deleted')::boolean;
    v_blob_id:=case when v_item->'blobId'='null'::jsonb then null else v_item->>'blobId' end;
    v_encryption_version:=(v_item->>'encryptionVersion')::smallint;
    v_key_generation:=(v_item->>'keyGeneration')::integer;
    v_algorithm:=v_item->>'algorithm';
    v_nonce:=v_item->>'nonce';
    v_ciphertext:=v_item->>'ciphertext';
    v_sequence:=v_next_sequence;
    v_next_sequence:=v_next_sequence+1;
    v_now:=clock_timestamp();

    insert into vault_private.entity_heads(
      vault_id,account_id,entity_id,entity_type,remote_revision,sequence,
      parent_id,name_token,deleted,blob_id,schema_version,encryption_version,
      key_generation,algorithm,nonce,ciphertext,operation_id,
      updated_by_device,updated_at
    ) values(
      v_vault_id,v_account,v_entity_id,v_entity_type,v_remote_revision,v_sequence,
      v_parent_id,v_name_token,v_deleted,v_blob_id,v_schema_version,
      v_encryption_version,v_key_generation,v_algorithm,v_nonce,v_ciphertext,
      v_operation_id,v_device_id,v_now
    )
    on conflict(vault_id,entity_id) do update set
      entity_type=excluded.entity_type,
      remote_revision=excluded.remote_revision,
      sequence=excluded.sequence,
      parent_id=excluded.parent_id,
      name_token=excluded.name_token,
      deleted=excluded.deleted,
      blob_id=excluded.blob_id,
      schema_version=excluded.schema_version,
      encryption_version=excluded.encryption_version,
      key_generation=excluded.key_generation,
      algorithm=excluded.algorithm,
      nonce=excluded.nonce,
      ciphertext=excluded.ciphertext,
      operation_id=excluded.operation_id,
      updated_by_device=excluded.updated_by_device,
      updated_at=excluded.updated_at;

    insert into vault_private.entity_versions(
      vault_id,account_id,entity_id,entity_type,remote_revision,sequence,
      parent_id,name_token,deleted,blob_id,schema_version,encryption_version,
      key_generation,algorithm,nonce,ciphertext,operation_id,
      updated_by_device,created_at
    ) values(
      v_vault_id,v_account,v_entity_id,v_entity_type,v_remote_revision,v_sequence,
      v_parent_id,v_name_token,v_deleted,v_blob_id,v_schema_version,
      v_encryption_version,v_key_generation,v_algorithm,v_nonce,v_ciphertext,
      v_operation_id,v_device_id,v_now
    );

    insert into vault_private.sync_events(
      vault_id,account_id,sequence,operation_id,entity_id,
      entity_type,remote_revision,kind,device_id,created_at
    ) values(
      v_vault_id,v_account,v_sequence,v_operation_id,v_entity_id,
      v_entity_type,v_remote_revision,'put',v_device_id,v_now
    );

    v_snapshot:=vault_private.entity_snapshot_json(
      v_vault_id,v_entity_id,v_entity_type,v_remote_revision,v_sequence,
      v_schema_version,v_parent_id,v_name_token,v_deleted,v_blob_id,
      v_encryption_version,v_key_generation,v_algorithm,v_nonce,v_ciphertext,
      v_operation_id,v_device_id,v_now
    );
    v_snapshots:=v_snapshots||jsonb_build_array(v_snapshot);
    v_last_sequence:=v_sequence;
  end loop;

  update vault_private.sync_v2_vault_state
  set next_sequence=v_next_sequence,updated_at=now()
  where vault_id=v_vault_id and account_id=v_account;

  v_result:=jsonb_build_object(
    'status','ok',
    'operationId',v_operation_id::text,
    'firstSequence',v_first_sequence::text,
    'through',v_last_sequence::text,
    'snapshots',v_snapshots
  );

  insert into vault_private.accepted_operations(
    vault_id,account_id,operation_id,device_id,protocol_version,
    sha256,wire_text,mutation_count,first_sequence,last_sequence,result
  ) values(
    v_vault_id,v_account,v_operation_id,v_device_id,2,
    p_sha256,p_wire,jsonb_array_length(v_wire->'mutations'),
    v_first_sequence,v_last_sequence,v_result
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pull / acknowledgement
-- ---------------------------------------------------------------------------

create or replace function public.vault_sync_pull_v2(
  p_vault_id uuid,
  p_epoch uuid,
  p_device_id uuid,
  p_after text,
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_after bigint;
  v_high bigint;
  v_through bigint;
  v_events jsonb;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  perform vault_private.require_v2_device(p_vault_id,v_account,p_device_id);

  if p_after !~ '^(0|[1-9][0-9]*)$'
    or char_length(p_after)>19
    or p_limit is null
    or p_limit<1
    or p_limit>1000 then
    raise exception 'Invalid Protocol v2 pull cursor or page size';
  end if;
  begin
    v_after:=p_after::bigint;
  exception when others then
    raise exception 'Invalid Protocol v2 pull cursor';
  end;

  perform 1
  from vault_private.sync_v2_vault_state s
  where s.vault_id=p_vault_id
    and s.account_id=v_account
    and s.epoch=p_epoch;
  if not found then
    raise exception 'Protocol v2 Vault/epoch mismatch';
  end if;

  select s.next_sequence-1
  into v_high
  from vault_private.sync_v2_vault_state s
  where s.vault_id=p_vault_id and s.account_id=v_account;

  if v_after<0 or v_after>v_high then
    raise exception 'Protocol v2 pull cursor is outside current history';
  end if;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'sequence',q.sequence::text,
      'operationId',q.operation_id::text,
      'entityId',q.entity_id::text,
      'entityType',q.entity_type,
      'remoteRevision',q.remote_revision::text,
      'kind','put',
      'snapshot',vault_private.entity_version_snapshot_json(q.version_row)
    ) order by q.sequence),'[]'::jsonb),
    coalesce(max(q.sequence),v_after)
  into v_events,v_through
  from (
    select
      e.sequence,e.operation_id,e.entity_id,e.entity_type,e.remote_revision,
      v as version_row
    from vault_private.sync_events e
    join vault_private.entity_versions v
      on v.vault_id=e.vault_id
      and v.entity_id=e.entity_id
      and v.remote_revision=e.remote_revision
    where e.vault_id=p_vault_id
      and e.account_id=v_account
      and e.sequence>v_after
      and e.sequence<=v_high
    order by e.sequence
    limit p_limit
  ) q;

  return jsonb_build_object(
    'protocolVersion',2,
    'vaultId',p_vault_id::text,
    'epoch',p_epoch::text,
    'after',v_after::text,
    'through',v_through::text,
    'highWatermark',v_high::text,
    'events',v_events
  );
end;
$$;

create or replace function public.vault_sync_ack_v2(
  p_vault_id uuid,
  p_epoch uuid,
  p_device_id uuid,
  p_through text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_through bigint;
  v_high bigint;
  v_current bigint;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  perform vault_private.require_v2_device(p_vault_id,v_account,p_device_id);

  if p_through !~ '^(0|[1-9][0-9]*)$' or char_length(p_through)>19 then
    raise exception 'Invalid Protocol v2 acknowledgement cursor';
  end if;
  begin
    v_through:=p_through::bigint;
  exception when others then
    raise exception 'Invalid Protocol v2 acknowledgement cursor';
  end;

  select s.next_sequence-1
  into v_high
  from vault_private.sync_v2_vault_state s
  where s.vault_id=p_vault_id
    and s.account_id=v_account
    and s.epoch=p_epoch;
  if not found then
    raise exception 'Protocol v2 Vault/epoch mismatch';
  end if;
  if v_through<0 or v_through>v_high then
    raise exception 'Protocol v2 acknowledgement is outside current history';
  end if;

  select d.last_acked_sequence
  into v_current
  from vault_private.device_vault_state d
  where d.vault_id=p_vault_id
    and d.account_id=v_account
    and d.device_id=p_device_id
  for update;

  if found and v_through<v_current then
    raise exception 'Protocol v2 acknowledgement cannot move backwards';
  end if;

  insert into vault_private.device_vault_state(
    vault_id,account_id,device_id,last_acked_sequence,last_seen_at
  ) values(
    p_vault_id,v_account,p_device_id,v_through,now()
  )
  on conflict(vault_id,account_id,device_id) do update
    set last_acked_sequence=greatest(
      vault_private.device_vault_state.last_acked_sequence,
      excluded.last_acked_sequence
    ),
    last_seen_at=now();

  return jsonb_build_object(
    'vaultId',p_vault_id::text,
    'epoch',p_epoch::text,
    'acknowledgedThrough',v_through::text,
    'highWatermark',v_high::text
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixed-high-watermark bootstrap primitives
-- ---------------------------------------------------------------------------

create or replace function public.vault_sync_begin_bootstrap_v2(
  p_vault_id uuid,
  p_epoch uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_high bigint;
  v_count bigint;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  perform vault_private.require_v2_device(p_vault_id,v_account,p_device_id);

  select s.next_sequence-1
  into v_high
  from vault_private.sync_v2_vault_state s
  where s.vault_id=p_vault_id
    and s.account_id=v_account
    and s.epoch=p_epoch;
  if not found then
    raise exception 'Protocol v2 Vault/epoch mismatch';
  end if;

  select count(distinct v.entity_id) into v_count
  from vault_private.entity_versions v
  where v.vault_id=p_vault_id
    and v.account_id=v_account
    and v.sequence<=v_high;

  return jsonb_build_object(
    'protocolVersion',2,
    'vaultId',p_vault_id::text,
    'epoch',p_epoch::text,
    'snapshotSequence',v_high::text,
    'entityCount',v_count
  );
end;
$$;

create or replace function public.vault_sync_bootstrap_page_v2(
  p_vault_id uuid,
  p_epoch uuid,
  p_device_id uuid,
  p_snapshot_sequence text,
  p_after_entity_id uuid default null,
  p_limit integer default 250
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_snapshot bigint;
  v_high bigint;
  v_items jsonb;
  v_returned integer;
  v_has_more boolean;
  v_last_entity uuid;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  perform vault_private.require_v2_device(p_vault_id,v_account,p_device_id);

  if p_snapshot_sequence !~ '^(0|[1-9][0-9]*)$'
    or char_length(p_snapshot_sequence)>19
    or p_limit is null
    or p_limit<1
    or p_limit>1000 then
    raise exception 'Invalid Protocol v2 bootstrap cursor or page size';
  end if;
  begin
    v_snapshot:=p_snapshot_sequence::bigint;
  exception when others then
    raise exception 'Invalid Protocol v2 bootstrap snapshot cursor';
  end;

  select s.next_sequence-1
  into v_high
  from vault_private.sync_v2_vault_state s
  where s.vault_id=p_vault_id
    and s.account_id=v_account
    and s.epoch=p_epoch;
  if not found then
    raise exception 'Protocol v2 Vault/epoch mismatch';
  end if;
  if v_snapshot<0 or v_snapshot>v_high then
    raise exception 'Protocol v2 bootstrap snapshot is outside retained history';
  end if;

  with latest as (
    select distinct on (v.entity_id) v.*
    from vault_private.entity_versions v
    where v.vault_id=p_vault_id
      and v.account_id=v_account
      and v.sequence<=v_snapshot
      and (p_after_entity_id is null or v.entity_id>p_after_entity_id)
    order by v.entity_id,v.sequence desc
  ),
  page as (
    select l.*
    from latest l
    order by l.entity_id
    limit p_limit+1
  ),
  returned as (
    select p.*
    from page p
    order by p.entity_id
    limit p_limit
  )
  select
    coalesce(jsonb_agg(
      vault_private.entity_snapshot_json(
        r.vault_id,r.entity_id,r.entity_type,r.remote_revision,r.sequence,
        r.schema_version,r.parent_id,r.name_token,r.deleted,r.blob_id,
        r.encryption_version,r.key_generation,r.algorithm,r.nonce,r.ciphertext,
        r.operation_id,r.updated_by_device,r.created_at
      )
      order by r.entity_id
    ),'[]'::jsonb),
    count(*)::integer,
    max(r.entity_id::text)::uuid
  into v_items,v_returned,v_last_entity
  from returned r;

  with latest as (
    select distinct on (v.entity_id) v.entity_id
    from vault_private.entity_versions v
    where v.vault_id=p_vault_id
      and v.account_id=v_account
      and v.sequence<=v_snapshot
      and (p_after_entity_id is null or v.entity_id>p_after_entity_id)
    order by v.entity_id,v.sequence desc
  )
  select count(*)>p_limit
  into v_has_more
  from latest;

  return jsonb_build_object(
    'protocolVersion',2,
    'vaultId',p_vault_id::text,
    'epoch',p_epoch::text,
    'snapshotSequence',v_snapshot::text,
    'afterEntityId',case
      when p_after_entity_id is null then null
      else to_jsonb(p_after_entity_id::text)
    end,
    'nextAfterEntityId',case
      when v_has_more and v_last_entity is not null
        then to_jsonb(v_last_entity::text)
      else null
    end,
    'done',not v_has_more,
    'items',v_items
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- API permissions
-- ---------------------------------------------------------------------------

revoke all on function public.vault_sync_upgrade_v2(uuid,uuid) from public,anon;
revoke all on function public.vault_sync_push_v2(text,text) from public,anon;
revoke all on function public.vault_sync_pull_v2(uuid,uuid,uuid,text,integer) from public,anon;
revoke all on function public.vault_sync_ack_v2(uuid,uuid,uuid,text) from public,anon;
revoke all on function public.vault_sync_begin_bootstrap_v2(uuid,uuid,uuid) from public,anon;
revoke all on function public.vault_sync_bootstrap_page_v2(uuid,uuid,uuid,text,uuid,integer) from public,anon;

grant execute on function public.vault_sync_upgrade_v2(uuid,uuid) to authenticated;
grant execute on function public.vault_sync_push_v2(text,text) to authenticated;
grant execute on function public.vault_sync_pull_v2(uuid,uuid,uuid,text,integer) to authenticated;
grant execute on function public.vault_sync_ack_v2(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.vault_sync_begin_bootstrap_v2(uuid,uuid,uuid) to authenticated;
grant execute on function public.vault_sync_bootstrap_page_v2(uuid,uuid,uuid,text,uuid,integer) to authenticated;

comment on table vault_private.entity_heads is
  'Current Protocol v2 encrypted entity heads. No plaintext canonical content.';
comment on table vault_private.entity_versions is
  'Immutable Protocol v2 encrypted entity versions; retained indefinitely until a future audited compaction design.';
comment on table vault_private.accepted_operations is
  'Immutable accepted Protocol v2 operation bytes/digests and idempotent results.';
comment on table vault_private.sync_events is
  'Contiguous per-Vault Protocol v2 event stream; payload is joined from immutable entity_versions.';
comment on table vault_private.blob_refs is
  'Opaque encrypted-blob metadata. I7 supplies object-transfer lifecycle; no plaintext hash/name/MIME.';
