-- I7 — Encrypted Attachments & Blob Transport
--
-- Adds an isolated private Storage bucket and owner-only Protocol-v2 blob
-- lifecycle RPCs. Object names contain only VaultId / key generation / opaque
-- BlobId. Filenames, MIME types, plaintext hashes and plaintext sizes remain
-- inside authenticated entity ciphertext.
--
-- Historical v1 "vault-sync" Storage remains untouched.

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'vault-e2ee-blobs',
  'vault-e2ee-blobs',
  false,
  134217764,
  array['application/octet-stream']::text[]
)
on conflict(id) do update
set public=false,
    file_size_limit=excluded.file_size_limit,
    allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists vault_e2ee_blobs_insert on storage.objects;
create policy vault_e2ee_blobs_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id='vault-e2ee-blobs'
  and array_length(storage.foldername(name),1)=2
  and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and (storage.foldername(name))[2] ~ '^[1-9][0-9]*$'
  and storage.filename(name) ~ '^[A-Za-z0-9_-]{43}$'
  and exists(
    select 1
    from public.vault_cloud_vaults v
    where v.id::text=(storage.foldername(storage.objects.name))[1]
      and v.auth_user_id=(select auth.uid())
      and v.protocol_version=2
      and v.disabled_at is null
  )
);

drop policy if exists vault_e2ee_blobs_select on storage.objects;
create policy vault_e2ee_blobs_select
on storage.objects
for select
to authenticated
using (
  storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info'])
  and bucket_id='vault-e2ee-blobs'
  and array_length(storage.foldername(name),1)=2
  and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and (storage.foldername(name))[2] ~ '^[1-9][0-9]*$'
  and storage.filename(name) ~ '^[A-Za-z0-9_-]{43}$'
  and exists(
    select 1
    from public.vault_cloud_vaults v
    where v.id::text=(storage.foldername(storage.objects.name))[1]
      and v.auth_user_id=(select auth.uid())
      and v.protocol_version=2
      and v.disabled_at is null
  )
);

create or replace function public.vault_sync_prepare_blob_v2(
  p_vault_id uuid,
  p_device_id uuid,
  p_blob_id text,
  p_key_generation integer,
  p_ciphertext_size bigint
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $fn$
declare
  v_account uuid:=vault_private.current_account_id();
  v_active_generation integer;
  v_path text;
  v_ref vault_private.blob_refs%rowtype;
  v_object_size bigint;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if p_blob_id !~ '^[A-Za-z0-9_-]{43}$'
    or p_key_generation is null or p_key_generation<1
    or p_ciphertext_size is null
    or p_ciphertext_size<36
    or p_ciphertext_size>134217764 then
    raise exception 'Invalid Protocol v2 encrypted blob descriptor';
  end if;

  v_active_generation:=vault_private.require_v2_device(
    p_vault_id,v_account,p_device_id
  );
  if p_key_generation<>v_active_generation then
    raise exception 'Encrypted blob uses a stale Vault key generation' using errcode='42501';
  end if;

  v_path:=p_vault_id::text||'/'||p_key_generation::text||'/'||p_blob_id;

  select * into v_ref
  from vault_private.blob_refs b
  where b.vault_id=p_vault_id
    and b.account_id=v_account
    and b.blob_id=p_blob_id
    and b.key_generation=p_key_generation
  for update;

  if found and v_ref.ciphertext_size is not null
    and v_ref.ciphertext_size<>p_ciphertext_size then
    raise exception 'BlobId was reused with a different ciphertext size';
  end if;

  insert into vault_private.blob_refs(
    vault_id,account_id,blob_id,key_generation,state,ciphertext_size
  ) values(
    p_vault_id,v_account,p_blob_id,p_key_generation,'pending',p_ciphertext_size
  )
  on conflict(vault_id,account_id,blob_id,key_generation)
  do update set ciphertext_size=excluded.ciphertext_size;

  select nullif(o.metadata->>'size','')::bigint
  into v_object_size
  from storage.objects o
  where o.bucket_id='vault-e2ee-blobs'
    and o.name=v_path
    and o.archived_at is null
    and coalesce(o.is_delete_marker,false)=false
  limit 1;

  if found then
    if v_object_size is distinct from p_ciphertext_size then
      raise exception 'Stored encrypted blob size does not match its registered descriptor';
    end if;
    update vault_private.blob_refs
    set state='ready',ready_at=coalesce(ready_at,now())
    where vault_id=p_vault_id
      and account_id=v_account
      and blob_id=p_blob_id
      and key_generation=p_key_generation;
    return jsonb_build_object(
      'status','ready',
      'bucket','vault-e2ee-blobs',
      'path',v_path,
      'blobId',p_blob_id,
      'keyGeneration',p_key_generation,
      'ciphertextSize',p_ciphertext_size
    );
  end if;

  return jsonb_build_object(
    'status','upload',
    'bucket','vault-e2ee-blobs',
    'path',v_path,
    'blobId',p_blob_id,
    'keyGeneration',p_key_generation,
    'ciphertextSize',p_ciphertext_size
  );
end;
$fn$;

create or replace function public.vault_sync_commit_blob_v2(
  p_vault_id uuid,
  p_device_id uuid,
  p_blob_id text,
  p_key_generation integer,
  p_ciphertext_size bigint
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $fn$
declare
  v_account uuid:=vault_private.current_account_id();
  v_active_generation integer;
  v_path text;
  v_ref vault_private.blob_refs%rowtype;
  v_object_size bigint;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if p_blob_id !~ '^[A-Za-z0-9_-]{43}$'
    or p_key_generation is null or p_key_generation<1
    or p_ciphertext_size is null
    or p_ciphertext_size<36
    or p_ciphertext_size>134217764 then
    raise exception 'Invalid Protocol v2 encrypted blob descriptor';
  end if;

  v_active_generation:=vault_private.require_v2_device(
    p_vault_id,v_account,p_device_id
  );
  if p_key_generation<>v_active_generation then
    raise exception 'Encrypted blob uses a stale Vault key generation' using errcode='42501';
  end if;

  select * into v_ref
  from vault_private.blob_refs b
  where b.vault_id=p_vault_id
    and b.account_id=v_account
    and b.blob_id=p_blob_id
    and b.key_generation=p_key_generation
  for update;
  if not found or v_ref.ciphertext_size is distinct from p_ciphertext_size then
    raise exception 'Encrypted blob was not prepared with this exact descriptor';
  end if;

  v_path:=p_vault_id::text||'/'||p_key_generation::text||'/'||p_blob_id;
  select nullif(o.metadata->>'size','')::bigint
  into v_object_size
  from storage.objects o
  where o.bucket_id='vault-e2ee-blobs'
    and o.name=v_path
    and o.archived_at is null
    and coalesce(o.is_delete_marker,false)=false
  limit 1;

  if not found then
    raise exception 'Encrypted blob object is not present in private Storage';
  end if;
  if v_object_size is distinct from p_ciphertext_size then
    raise exception 'Encrypted blob object size is inconsistent';
  end if;

  update vault_private.blob_refs
  set state='ready',ready_at=coalesce(ready_at,now())
  where vault_id=p_vault_id
    and account_id=v_account
    and blob_id=p_blob_id
    and key_generation=p_key_generation;

  return jsonb_build_object(
    'status','ready',
    'bucket','vault-e2ee-blobs',
    'path',v_path,
    'blobId',p_blob_id,
    'keyGeneration',p_key_generation,
    'ciphertextSize',p_ciphertext_size
  );
end;
$fn$;

revoke all on function public.vault_sync_prepare_blob_v2(uuid,uuid,text,integer,bigint) from public,anon;
revoke all on function public.vault_sync_commit_blob_v2(uuid,uuid,text,integer,bigint) from public,anon;
grant execute on function public.vault_sync_prepare_blob_v2(uuid,uuid,text,integer,bigint) to authenticated;
grant execute on function public.vault_sync_commit_blob_v2(uuid,uuid,text,integer,bigint) to authenticated;

comment on function public.vault_sync_prepare_blob_v2(uuid,uuid,text,integer,bigint) is
  'I7: owner/device-authorized idempotent registration for opaque Protocol v2 ciphertext blobs.';
comment on function public.vault_sync_commit_blob_v2(uuid,uuid,text,integer,bigint) is
  'I7: marks a prepared Protocol v2 blob READY only after the exact private Storage object and size exist.';

create or replace function public.vault_sync_capabilities_v2()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $fn$
  select jsonb_build_object(
    'contractVersion',1,
    'protocolVersions',jsonb_build_array(1,2),
    'encryptedContentV2',jsonb_build_object(
      'contractAvailable',true,
      'acceptingContent',true
    ),
    'encryptedBlobsV2',jsonb_build_object(
      'contractAvailable',true,
      'acceptingContent',true,
      'bucket','vault-e2ee-blobs',
      'maxCiphertextBytes',134217764
    ),
    'maxMutations',1000,
    'maxPageEvents',1000
  );
$fn$;

revoke all on function public.vault_sync_capabilities_v2() from public,anon;
grant execute on function public.vault_sync_capabilities_v2() to authenticated;

comment on function public.vault_sync_capabilities_v2() is
  'I7: Protocol v2 encrypted Note/Folder/Attachment entities and opaque encrypted blob transport are enabled.';
