-- I7 — production RLS path qualification hardening.
--
-- The initial policy used an unqualified outer "name" inside the nested
-- vault_cloud_vaults EXISTS query. PostgreSQL correctly resolved that name to
-- the inner table's vault name. Qualify storage.objects.name so the membership
-- check is bound to the encrypted object's VaultId path segment.

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
