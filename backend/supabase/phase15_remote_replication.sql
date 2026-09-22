-- Phase 15 — Remote Replication, Conflict Resolution & Attachment Sync
-- Requires Phase 14 cloud account/device/Vault foundation.

create table if not exists public.vault_sync_counters (
  vault_id uuid primary key references public.vault_cloud_vaults(id) on delete cascade,
  account_id uuid not null,
  auth_user_id uuid not null,
  next_sequence bigint not null default 1 check (next_sequence >= 1),
  constraint vault_sync_counters_account_fk
    foreign key (account_id, auth_user_id)
    references public.vault_accounts(id, auth_user_id)
    on delete cascade
);

create table if not exists public.vault_sync_entries (
  vault_id uuid not null references public.vault_cloud_vaults(id) on delete cascade,
  entry_id uuid not null,
  account_id uuid not null,
  auth_user_id uuid not null,
  parent_id uuid null,
  name text not null check (char_length(name) between 1 and 240),
  kind text not null check (kind in ('directory','markdown','attachment')),
  revision integer not null check (revision between 1 and 2147483647),
  deleted_at timestamptz null,
  markdown_text text null,
  blob_sha256 text null,
  blob_mime_type text null,
  blob_size bigint null,
  updated_at timestamptz not null default now(),
  updated_by_device uuid not null,
  primary key (vault_id, entry_id),
  constraint vault_sync_entries_account_fk
    foreign key (account_id, auth_user_id)
    references public.vault_accounts(id, auth_user_id)
    on delete cascade,
  constraint vault_sync_entries_device_fk
    foreign key (account_id, updated_by_device)
    references public.vault_cloud_devices(account_id, id),
  constraint vault_sync_entries_parent_fk
    foreign key (vault_id, parent_id)
    references public.vault_sync_entries(vault_id, entry_id)
    deferrable initially immediate,
  constraint vault_sync_entries_content_ck check (
    (kind='directory' and markdown_text is null and blob_sha256 is null and blob_mime_type is null and blob_size is null)
    or
    (kind='markdown' and markdown_text is not null and blob_sha256 is null and blob_mime_type is null and blob_size is null)
    or
    (kind='attachment' and markdown_text is null and blob_sha256 ~ '^[0-9a-f]{64}$'
      and blob_mime_type is not null and char_length(blob_mime_type) between 1 and 200
      and blob_size is not null and blob_size between 0 and 134217728)
  )
);

create unique index if not exists vault_sync_entries_active_path_uq
  on public.vault_sync_entries (
    vault_id,
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
  )
  where deleted_at is null;

create index if not exists vault_sync_entries_parent_idx
  on public.vault_sync_entries(vault_id, parent_id)
  where deleted_at is null;

create table if not exists public.vault_sync_operations (
  vault_id uuid not null references public.vault_cloud_vaults(id) on delete cascade,
  operation_id uuid not null,
  account_id uuid not null,
  auth_user_id uuid not null,
  device_id uuid not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  wire jsonb not null,
  result jsonb null,
  created_at timestamptz not null default now(),
  primary key (vault_id, operation_id),
  constraint vault_sync_operations_account_fk
    foreign key (account_id, auth_user_id)
    references public.vault_accounts(id, auth_user_id)
    on delete cascade,
  constraint vault_sync_operations_device_fk
    foreign key (account_id, device_id)
    references public.vault_cloud_devices(account_id, id)
);

create index if not exists vault_sync_operations_device_idx
  on public.vault_sync_operations(account_id, device_id, created_at desc);

create table if not exists public.vault_sync_events (
  vault_id uuid not null references public.vault_cloud_vaults(id) on delete cascade,
  sequence bigint not null check (sequence >= 1),
  account_id uuid not null,
  auth_user_id uuid not null,
  operation_id uuid not null,
  entry_id uuid not null,
  revision integer not null check (revision >= 1),
  kind text not null check (kind in ('create','write','move','trash','restore')),
  device_id uuid not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (vault_id, sequence),
  constraint vault_sync_events_operation_fk
    foreign key (vault_id, operation_id)
    references public.vault_sync_operations(vault_id, operation_id)
    on delete cascade,
  constraint vault_sync_events_entry_fk
    foreign key (vault_id, entry_id)
    references public.vault_sync_entries(vault_id, entry_id)
    on delete cascade,
  constraint vault_sync_events_account_fk
    foreign key (account_id, auth_user_id)
    references public.vault_accounts(id, auth_user_id)
    on delete cascade,
  constraint vault_sync_events_device_fk
    foreign key (account_id, device_id)
    references public.vault_cloud_devices(account_id, id)
);

create index if not exists vault_sync_events_operation_idx
  on public.vault_sync_events(vault_id, operation_id);

alter table public.vault_sync_counters enable row level security;
alter table public.vault_sync_entries enable row level security;
alter table public.vault_sync_operations enable row level security;
alter table public.vault_sync_events enable row level security;

revoke all on public.vault_sync_counters from anon, authenticated;
revoke all on public.vault_sync_entries from anon, authenticated;
revoke all on public.vault_sync_operations from anon, authenticated;
revoke all on public.vault_sync_events from anon, authenticated;

create or replace function vault_private.valid_sync_name(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select p_name is not null
    and char_length(p_name) between 1 and 240
    and octet_length(p_name) <= 240
    and p_name = normalize(p_name, NFC)
    and p_name = btrim(p_name)
    and p_name not in ('.','..')
    and p_name !~ E'[\\x00-\\x1f\\x7f/\\\\<>:"|?*]'
    and p_name !~ '[. ]$'
    and p_name !~* '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)';
$fn$;

create or replace function vault_private.sync_snapshot(p_entry public.vault_sync_entries)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'entryId', p_entry.entry_id::text,
    'vaultId', p_entry.vault_id::text,
    'parentId', case when p_entry.parent_id is null then null else to_jsonb(p_entry.parent_id::text) end,
    'name', p_entry.name,
    'kind', p_entry.kind,
    'revision', p_entry.revision,
    'deletedAt', case when p_entry.deleted_at is null then null else to_jsonb(p_entry.deleted_at::text) end,
    'updatedAt', p_entry.updated_at::text,
    'updatedByDevice', p_entry.updated_by_device::text,
    'text', case when p_entry.markdown_text is null then null else to_jsonb(p_entry.markdown_text) end,
    'attachmentSha256', case when p_entry.blob_sha256 is null then null else to_jsonb(p_entry.blob_sha256) end,
    'attachmentMimeType', case when p_entry.blob_mime_type is null then null else to_jsonb(p_entry.blob_mime_type) end,
    'attachmentSize', p_entry.blob_size
  );
$fn$;

create or replace function vault_private.raise_sync_conflict(
  p_reason text,
  p_entry_id uuid,
  p_current jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise sqlstate 'PT409'
    using message = jsonb_build_object(
      'status','conflict',
      'reason',p_reason,
      'entryId',p_entry_id::text,
      'current',p_current
    )::text;
end;
$$;

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
  where v.id=p_vault_id
    and v.auth_user_id=v_uid
    and v.epoch=p_epoch
    and v.protocol_version=1
    and v.disabled_at is null;
  if not found then raise exception 'cloud Vault/account/epoch mismatch'; end if;

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

  select a.id into v_account_id
  from public.vault_accounts a
  where a.auth_user_id=v_uid;
  if v_account_id is null then raise exception 'cloud account mapping is missing'; end if;

  perform 1
  from public.vault_cloud_vaults v
  where v.id=v_vault_id
    and v.account_id=v_account_id
    and v.auth_user_id=v_uid
    and v.protocol_version=1
    and v.disabled_at is null;
  if not found then raise exception 'cloud Vault is unavailable'; end if;

  perform 1
  from public.vault_cloud_devices d
  where d.account_id=v_account_id
    and d.id=v_device_id
    and d.auth_user_id=v_uid
    and d.revoked_at is null;
  if not found then raise exception 'device is not authorized for synchronization'; end if;

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
  values(v_vault_id,v_account_id,v_uid,1)
  on conflict (vault_id) do nothing;

  perform 1 from public.vault_sync_counters c where c.vault_id=v_vault_id for update;

  insert into public.vault_sync_operations(
    vault_id,operation_id,account_id,auth_user_id,device_id,sha256,wire
  ) values(
    v_vault_id,v_operation_id,v_account_id,v_uid,v_device_id,p_sha256,p_wire
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
        v_blob_path:=v_uid::text||'/'||v_vault_id::text||'/'||v_blob_sha;
        perform 1 from storage.objects o where o.bucket_id='vault-sync' and o.name=v_blob_path;
        if not found then raise exception 'attachment blob must be uploaded before its create operation'; end if;
      end if;

      if v_entry_kind='markdown' and octet_length(coalesce(v_mutation->>'text','')) > 16777216 then
        raise exception 'Markdown payload exceeds 16 MB sync limit';
      end if;

      insert into public.vault_sync_entries(
        vault_id,entry_id,account_id,auth_user_id,parent_id,name,kind,revision,deleted_at,
        markdown_text,blob_sha256,blob_mime_type,blob_size,updated_at,updated_by_device
      ) values(
        v_vault_id,v_entry_id,v_account_id,v_uid,v_parent_id,v_name,v_entry_kind,1,null,
        case when v_entry_kind='markdown' then coalesce(v_mutation->>'text','') else null end,
        v_blob_sha,v_blob_mime,v_blob_size,now(),v_device_id
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
        set markdown_text=v_mutation->>'text',revision=revision+1,updated_at=now(),updated_by_device=v_device_id
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
        set parent_id=v_parent_id,name=v_name,revision=revision+1,updated_at=now(),updated_by_device=v_device_id
        where vault_id=v_vault_id and entry_id=v_entry_id
        returning * into v_entry;

      elsif v_kind='trash' then
        update public.vault_sync_entries
        set deleted_at=coalesce(deleted_at,now()),revision=revision+1,updated_at=now(),updated_by_device=v_device_id
        where vault_id=v_vault_id and entry_id=v_entry_id
        returning * into v_entry;

      else
        if v_entry.deleted_at is null then
          update public.vault_sync_entries
          set revision=revision+1,updated_at=now(),updated_by_device=v_device_id
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
          set deleted_at=null,revision=revision+1,updated_at=now(),updated_by_device=v_device_id
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
      vault_id,sequence,account_id,auth_user_id,operation_id,entry_id,revision,kind,device_id,snapshot
    ) values(
      v_vault_id,v_sequence,v_account_id,v_uid,v_operation_id,v_entry.entry_id,v_entry.revision,v_kind,v_device_id,v_snapshot
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

revoke all on function public.vault_sync_pull(uuid,uuid,text,integer) from public, anon;
revoke all on function public.vault_sync_push(jsonb,text) from public, anon;
grant execute on function public.vault_sync_pull(uuid,uuid,text,integer) to authenticated;
grant execute on function public.vault_sync_push(jsonb,text) to authenticated;

-- Private content-addressed attachment bucket.
insert into storage.buckets(id,name,public,file_size_limit)
values('vault-sync','vault-sync',false,134217728)
on conflict(id) do update
set public=false,file_size_limit=excluded.file_size_limit;

drop policy if exists vault_sync_objects_select on storage.objects;
create policy vault_sync_objects_select
on storage.objects for select
to authenticated
using (
  bucket_id='vault-sync'
  and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists (
    select 1 from public.vault_cloud_vaults v
    where v.id::text=(storage.foldername(name))[2]
      and v.auth_user_id=(select auth.uid())
      and v.disabled_at is null
  )
);

drop policy if exists vault_sync_objects_insert on storage.objects;
create policy vault_sync_objects_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id='vault-sync'
  and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists (
    select 1 from public.vault_cloud_vaults v
    where v.id::text=(storage.foldername(name))[2]
      and v.auth_user_id=(select auth.uid())
      and v.disabled_at is null
  )
);

    and p_name !~* '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)';
$;

create or replace function vault_private.sync_snapshot(p_entry public.vault_sync_entries)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'entryId', p_entry.entry_id::text,
    'vaultId', p_entry.vault_id::text,
    'parentId', case when p_entry.parent_id is null then null else to_jsonb(p_entry.parent_id::text) end,
    'name', p_entry.name,
    'kind', p_entry.kind,
    'revision', p_entry.revision,
    'deletedAt', case when p_entry.deleted_at is null then null else to_jsonb(p_entry.deleted_at::text) end,
    'updatedAt', p_entry.updated_at::text,
    'updatedByDevice', p_entry.updated_by_device::text,
    'text', case when p_entry.markdown_text is null then null else to_jsonb(p_entry.markdown_text) end,
    'attachmentSha256', case when p_entry.blob_sha256 is null then null else to_jsonb(p_entry.blob_sha256) end,
    'attachmentMimeType', case when p_entry.blob_mime_type is null then null else to_jsonb(p_entry.blob_mime_type) end,
    'attachmentSize', p_entry.blob_size
  );
$$;

create or replace function vault_private.raise_sync_conflict(
  p_reason text,
  p_entry_id uuid,
  p_current jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise sqlstate 'PT409'
    using message = jsonb_build_object(
      'status','conflict',
      'reason',p_reason,
      'entryId',p_entry_id::text,
      'current',p_current
    )::text;
end;
$$;

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
  where v.id=p_vault_id
    and v.auth_user_id=v_uid
    and v.epoch=p_epoch
    and v.protocol_version=1
    and v.disabled_at is null;
  if not found then raise exception 'cloud Vault/account/epoch mismatch'; end if;

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

  select a.id into v_account_id
  from public.vault_accounts a
  where a.auth_user_id=v_uid;
  if v_account_id is null then raise exception 'cloud account mapping is missing'; end if;

  perform 1
  from public.vault_cloud_vaults v
  where v.id=v_vault_id
    and v.account_id=v_account_id
    and v.auth_user_id=v_uid
    and v.protocol_version=1
    and v.disabled_at is null;
  if not found then raise exception 'cloud Vault is unavailable'; end if;

  perform 1
  from public.vault_cloud_devices d
  where d.account_id=v_account_id
    and d.id=v_device_id
    and d.auth_user_id=v_uid
    and d.revoked_at is null;
  if not found then raise exception 'device is not authorized for synchronization'; end if;

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
  values(v_vault_id,v_account_id,v_uid,1)
  on conflict (vault_id) do nothing;

  perform 1 from public.vault_sync_counters c where c.vault_id=v_vault_id for update;

  insert into public.vault_sync_operations(
    vault_id,operation_id,account_id,auth_user_id,device_id,sha256,wire
  ) values(
    v_vault_id,v_operation_id,v_account_id,v_uid,v_device_id,p_sha256,p_wire
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
        or v_name is null or char_length(v_name)<1 or char_length(v_name)>240
        or v_name ~ '[\\/]' or v_name ~ '[\x00-\x1f\x7f]' then
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
        and e.parent_id is not distinct from v_parent_id and lower(e.name)=lower(v_name)
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
        v_blob_path:=v_uid::text||'/'||v_vault_id::text||'/'||v_blob_sha;
        perform 1 from storage.objects o where o.bucket_id='vault-sync' and o.name=v_blob_path;
        if not found then raise exception 'attachment blob must be uploaded before its create operation'; end if;
      end if;

      insert into public.vault_sync_entries(
        vault_id,entry_id,account_id,auth_user_id,parent_id,name,kind,revision,deleted_at,
        markdown_text,blob_sha256,blob_mime_type,blob_size,updated_at,updated_by_device
      ) values(
        v_vault_id,v_entry_id,v_account_id,v_uid,v_parent_id,v_name,v_entry_kind,1,null,
        case when v_entry_kind='markdown' then coalesce(v_mutation->>'text','') else null end,
        v_blob_sha,v_blob_mime,v_blob_size,now(),v_device_id
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
        update public.vault_sync_entries
        set markdown_text=v_mutation->>'text',revision=revision+1,updated_at=now(),updated_by_device=v_device_id
        where vault_id=v_vault_id and entry_id=v_entry_id
        returning * into v_entry;

      elsif v_kind='move' then
        v_name:=v_mutation->>'name';
        if v_name is null or char_length(v_name)<1 or char_length(v_name)>240
          or v_name ~ '[\\/]' or v_name ~ '[\x00-\x1f\x7f]' then raise exception 'invalid move name'; end if;
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
        if v_entry.deleted_at is null then
          select * into v_collision from public.vault_sync_entries e
          where e.vault_id=v_vault_id and e.deleted_at is null and e.entry_id<>v_entry_id
            and e.parent_id is not distinct from v_parent_id and lower(e.name)=lower(v_name)
          limit 1;
          if found then
            perform vault_private.raise_sync_conflict('path',v_entry_id,vault_private.sync_snapshot(v_collision));
          end if;
        end if;
        update public.vault_sync_entries
        set parent_id=v_parent_id,name=v_name,revision=revision+1,updated_at=now(),updated_by_device=v_device_id
        where vault_id=v_vault_id and entry_id=v_entry_id
        returning * into v_entry;

      elsif v_kind='trash' then
        update public.vault_sync_entries
        set deleted_at=coalesce(deleted_at,now()),revision=revision+1,updated_at=now(),updated_by_device=v_device_id
        where vault_id=v_vault_id and entry_id=v_entry_id
        returning * into v_entry;

      else
        if v_entry.deleted_at is null then
          update public.vault_sync_entries
          set revision=revision+1,updated_at=now(),updated_by_device=v_device_id
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
            and e.parent_id is not distinct from v_entry.parent_id and lower(e.name)=lower(v_entry.name)
          limit 1;
          if found then
            perform vault_private.raise_sync_conflict('path',v_entry_id,vault_private.sync_snapshot(v_collision));
          end if;
          update public.vault_sync_entries
          set deleted_at=null,revision=revision+1,updated_at=now(),updated_by_device=v_device_id
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
      vault_id,sequence,account_id,auth_user_id,operation_id,entry_id,revision,kind,device_id,snapshot
    ) values(
      v_vault_id,v_sequence,v_account_id,v_uid,v_operation_id,v_entry.entry_id,v_entry.revision,v_kind,v_device_id,v_snapshot
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

revoke all on function public.vault_sync_pull(uuid,uuid,text,integer) from public, anon;
revoke all on function public.vault_sync_push(jsonb,text) from public, anon;
grant execute on function public.vault_sync_pull(uuid,uuid,text,integer) to authenticated;
grant execute on function public.vault_sync_push(jsonb,text) to authenticated;

-- Private content-addressed attachment bucket.
insert into storage.buckets(id,name,public,file_size_limit)
values('vault-sync','vault-sync',false,134217728)
on conflict(id) do update
set public=false,file_size_limit=excluded.file_size_limit;

drop policy if exists vault_sync_objects_select on storage.objects;
create policy vault_sync_objects_select
on storage.objects for select
to authenticated
using (
  bucket_id='vault-sync'
  and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists (
    select 1 from public.vault_cloud_vaults v
    where v.id::text=(storage.foldername(name))[2]
      and v.auth_user_id=(select auth.uid())
      and v.disabled_at is null
  )
);

drop policy if exists vault_sync_objects_insert on storage.objects;
create policy vault_sync_objects_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id='vault-sync'
  and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists (
    select 1 from public.vault_cloud_vaults v
    where v.id::text=(storage.foldername(name))[2]
      and v.auth_user_id=(select auth.uid())
      and v.disabled_at is null
  )
);
