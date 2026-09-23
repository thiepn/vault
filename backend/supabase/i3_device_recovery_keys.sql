-- I3 — Device Keys, Recovery Secret & Key Distribution
-- Requires Phase 14, Phase 18 membership architecture and I1.
--
-- Sensitive cryptographic registry tables live only in vault_private. Browser
-- clients interact through narrowly-scoped RPCs. Canonical Vault content sync
-- remains disabled; this migration distributes keys only.

create table if not exists vault_private.device_keys (
  account_id uuid not null,
  device_id uuid not null,
  algorithm text not null check (algorithm='RSA-OAEP-3072-SHA256'),
  public_spki text not null check (char_length(public_spki) between 256 and 2048 and public_spki ~ '^[A-Za-z0-9_-]+$'),
  fingerprint text not null check (fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz not null default now(),
  primary key(account_id,device_id),
  constraint device_keys_device_fk
    foreign key(account_id,device_id)
    references public.vault_cloud_devices(account_id,id)
    on delete cascade
);

create table if not exists vault_private.device_vault_key_envelopes (
  vault_id uuid not null,
  account_id uuid not null,
  device_id uuid not null,
  key_generation integer not null check (key_generation>=1),
  algorithm text not null check (algorithm='RSA-OAEP-3072-SHA256'),
  public_key_fingerprint text not null check (public_key_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  ciphertext text not null check (ciphertext ~ '^[A-Za-z0-9_-]{512}$'),
  created_at timestamptz not null default now(),
  primary key(vault_id,account_id,device_id,key_generation),
  constraint device_vault_envelope_membership_fk
    foreign key(vault_id,account_id)
    references public.vault_memberships(vault_id,account_id)
    on delete cascade,
  constraint device_vault_envelope_device_fk
    foreign key(account_id,device_id)
    references public.vault_cloud_devices(account_id,id)
    on delete cascade
);

create table if not exists vault_private.recovery_vault_key_envelopes (
  vault_id uuid not null,
  account_id uuid not null,
  key_generation integer not null check (key_generation>=1),
  algorithm text not null check (algorithm='A256GCM'),
  nonce text not null check (nonce ~ '^[A-Za-z0-9_-]{16}$'),
  ciphertext text not null check (ciphertext ~ '^[A-Za-z0-9_-]{64}$'),
  recovery_proof text not null check (recovery_proof ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz not null default now(),
  primary key(vault_id,account_id,key_generation),
  constraint recovery_vault_envelope_membership_fk
    foreign key(vault_id,account_id)
    references public.vault_memberships(vault_id,account_id)
    on delete cascade
);

create table if not exists vault_private.device_vault_access (
  vault_id uuid not null,
  account_id uuid not null,
  device_id uuid not null,
  authorized_at timestamptz not null default now(),
  revoked_at timestamptz null,
  primary key(vault_id,account_id,device_id),
  constraint device_vault_access_membership_fk
    foreign key(vault_id,account_id)
    references public.vault_memberships(vault_id,account_id)
    on delete cascade,
  constraint device_vault_access_device_fk
    foreign key(account_id,device_id)
    references public.vault_cloud_devices(account_id,id)
    on delete cascade
);

create table if not exists vault_private.device_access_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  vault_id uuid not null,
  account_id uuid not null,
  device_id uuid not null,
  public_key_fingerprint text not null check (public_key_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  challenge text not null check (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expected_confirmation text null check (expected_confirmation is null or expected_confirmation ~ '^[A-Za-z0-9_-]{43}$'),
  key_generation integer null check (key_generation is null or key_generation>=1),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz null,
  confirmed_at timestamptz null,
  rejected_at timestamptz null,
  constraint device_access_request_membership_fk
    foreign key(vault_id,account_id)
    references public.vault_memberships(vault_id,account_id)
    on delete cascade,
  constraint device_access_request_device_fk
    foreign key(account_id,device_id)
    references public.vault_cloud_devices(account_id,id)
    on delete cascade
);

create index if not exists device_access_requests_vault_idx
  on vault_private.device_access_requests(vault_id,account_id,created_at desc);

alter table vault_private.device_keys enable row level security;
alter table vault_private.device_vault_key_envelopes enable row level security;
alter table vault_private.recovery_vault_key_envelopes enable row level security;
alter table vault_private.device_vault_access enable row level security;
alter table vault_private.device_access_requests enable row level security;

revoke all on vault_private.device_keys from public,anon,authenticated;
revoke all on vault_private.device_vault_key_envelopes from public,anon,authenticated;
revoke all on vault_private.recovery_vault_key_envelopes from public,anon,authenticated;
revoke all on vault_private.device_vault_access from public,anon,authenticated;
revoke all on vault_private.device_access_requests from public,anon,authenticated;

create or replace function vault_private.current_account_id()
returns uuid
language sql
stable
security definer
set search_path=''
as $$
  select a.id
  from public.vault_accounts a
  where a.auth_user_id=(select auth.uid())
  limit 1;
$$;

create or replace function vault_private.require_active_member(
  p_vault_id uuid,
  p_account_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  perform 1
  from public.vault_memberships m
  join public.vault_cloud_vaults v on v.id=m.vault_id
  where m.vault_id=p_vault_id
    and m.account_id=p_account_id
    and m.auth_user_id=(select auth.uid())
    and m.role='owner'
    and v.account_id=p_account_id
    and m.revoked_at is null
    and v.disabled_at is null;
  if not found then
    -- Cross-Account E2EE sharing is intentionally not enabled in I3.
    -- Only the canonical Vault owner may establish or receive VMK material.
    raise exception 'Encrypted Vault key access is limited to the canonical Vault owner' using errcode='42501';
  end if;
end;
$$;

create or replace function vault_private.require_active_device(
  p_account_id uuid,
  p_device_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  perform 1
  from public.vault_cloud_devices d
  where d.account_id=p_account_id
    and d.id=p_device_id
    and d.auth_user_id=(select auth.uid())
    and d.revoked_at is null;
  if not found then
    raise exception 'Device is unavailable or revoked' using errcode='42501';
  end if;
end;
$$;

create or replace function vault_private.require_authorized_device(
  p_vault_id uuid,
  p_account_id uuid,
  p_device_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  perform vault_private.require_active_member(p_vault_id,p_account_id);
  perform vault_private.require_active_device(p_account_id,p_device_id);
  perform 1
  from vault_private.device_vault_access a
  where a.vault_id=p_vault_id
    and a.account_id=p_account_id
    and a.device_id=p_device_id
    and a.revoked_at is null;
  if not found then
    raise exception 'Device is not authorized for this Vault' using errcode='42501';
  end if;
end;
$$;

create or replace function vault_private.readiness_json(
  p_vault_id uuid,
  p_account_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_generation integer;
  v_device boolean;
  v_recovery boolean;
  v_authorized boolean;
begin
  select max(e.key_generation)
  into v_generation
  from vault_private.device_vault_key_envelopes e
  where e.vault_id=p_vault_id and e.account_id=p_account_id and e.device_id=p_device_id;

  select exists(
    select 1 from vault_private.device_vault_key_envelopes e
    where e.vault_id=p_vault_id and e.account_id=p_account_id and e.device_id=p_device_id
      and e.key_generation=v_generation
  ) into v_device;

  select exists(
    select 1 from vault_private.recovery_vault_key_envelopes r
    where r.vault_id=p_vault_id and r.account_id=p_account_id and r.key_generation=v_generation
  ) into v_recovery;

  select exists(
    select 1 from vault_private.device_vault_access a
    join public.vault_cloud_devices d on d.account_id=a.account_id and d.id=a.device_id
    where a.vault_id=p_vault_id and a.account_id=p_account_id and a.device_id=p_device_id
      and a.revoked_at is null and d.revoked_at is null
  ) into v_authorized;

  return jsonb_build_object(
    'vaultId',p_vault_id::text,
    'deviceId',p_device_id::text,
    'keyGeneration',v_generation,
    'deviceEnvelope',coalesce(v_device,false),
    'recoveryEnvelope',coalesce(v_recovery,false),
    'deviceAuthorized',coalesce(v_authorized,false),
    'ready',coalesce(v_device,false) and coalesce(v_recovery,false) and coalesce(v_authorized,false)
  );
end;
$$;

create or replace function public.vault_key_register_device(
  p_account_id uuid,
  p_device_id uuid,
  p_algorithm text,
  p_public_spki text,
  p_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_existing vault_private.device_keys%rowtype;
begin
  if v_account is null or p_account_id<>v_account then raise exception 'Account mismatch' using errcode='42501'; end if;
  perform vault_private.require_active_device(v_account,p_device_id);
  if p_algorithm<>'RSA-OAEP-3072-SHA256'
    or p_public_spki !~ '^[A-Za-z0-9_-]+$'
    or char_length(p_public_spki) not between 256 and 2048
    or p_fingerprint !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'Invalid Device public key';
  end if;

  select * into v_existing from vault_private.device_keys k
  where k.account_id=v_account and k.device_id=p_device_id;
  if found then
    if v_existing.algorithm<>p_algorithm or v_existing.public_spki<>p_public_spki or v_existing.fingerprint<>p_fingerprint then
      raise exception 'Device public key is immutable' using errcode='23505';
    end if;
  else
    insert into vault_private.device_keys(account_id,device_id,algorithm,public_spki,fingerprint)
    values(v_account,p_device_id,p_algorithm,p_public_spki,p_fingerprint);
  end if;
  return jsonb_build_object('registered',true,'fingerprint',p_fingerprint);
end;
$$;

create or replace function public.vault_key_initialize_vault(
  p_account_id uuid,
  p_vault_id uuid,
  p_device_id uuid,
  p_key_generation integer,
  p_device_ciphertext text,
  p_public_key_fingerprint text,
  p_recovery_nonce text,
  p_recovery_ciphertext text,
  p_recovery_proof text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_key vault_private.device_keys%rowtype;
  v_existing_device vault_private.device_vault_key_envelopes%rowtype;
  v_existing_recovery vault_private.recovery_vault_key_envelopes%rowtype;
begin
  if v_account is null or p_account_id<>v_account then raise exception 'Account mismatch' using errcode='42501'; end if;
  if p_key_generation is null or p_key_generation<1
    or p_device_ciphertext !~ '^[A-Za-z0-9_-]{512}$'
    or p_public_key_fingerprint !~ '^[A-Za-z0-9_-]{43}$'
    or p_recovery_nonce !~ '^[A-Za-z0-9_-]{16}$'
    or p_recovery_ciphertext !~ '^[A-Za-z0-9_-]{64}$'
    or p_recovery_proof !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'Invalid Vault key envelope payload';
  end if;
  perform vault_private.require_active_member(p_vault_id,v_account);
  perform vault_private.require_active_device(v_account,p_device_id);
  select * into v_key from vault_private.device_keys k
  where k.account_id=v_account and k.device_id=p_device_id;
  if not found or v_key.fingerprint<>p_public_key_fingerprint then
    raise exception 'Registered Device key mismatch' using errcode='42501';
  end if;

  select * into v_existing_device
  from vault_private.device_vault_key_envelopes e
  where e.vault_id=p_vault_id and e.account_id=v_account and e.device_id=p_device_id and e.key_generation=p_key_generation;
  if found then
    if v_existing_device.ciphertext<>p_device_ciphertext or v_existing_device.public_key_fingerprint<>p_public_key_fingerprint then
      raise exception 'Device envelope identity is immutable';
    end if;
  else
    insert into vault_private.device_vault_key_envelopes(
      vault_id,account_id,device_id,key_generation,algorithm,public_key_fingerprint,ciphertext
    ) values(
      p_vault_id,v_account,p_device_id,p_key_generation,'RSA-OAEP-3072-SHA256',p_public_key_fingerprint,p_device_ciphertext
    );
  end if;

  select * into v_existing_recovery
  from vault_private.recovery_vault_key_envelopes r
  where r.vault_id=p_vault_id and r.account_id=v_account and r.key_generation=p_key_generation;
  if found then
    if v_existing_recovery.nonce<>p_recovery_nonce
      or v_existing_recovery.ciphertext<>p_recovery_ciphertext
      or v_existing_recovery.recovery_proof<>p_recovery_proof then
      raise exception 'Recovery envelope identity is immutable';
    end if;
  else
    insert into vault_private.recovery_vault_key_envelopes(
      vault_id,account_id,key_generation,algorithm,nonce,ciphertext,recovery_proof
    ) values(
      p_vault_id,v_account,p_key_generation,'A256GCM',p_recovery_nonce,p_recovery_ciphertext,p_recovery_proof
    );
  end if;

  insert into vault_private.device_vault_access(vault_id,account_id,device_id,authorized_at,revoked_at)
  values(p_vault_id,v_account,p_device_id,now(),null)
  on conflict(vault_id,account_id,device_id) do update
    set authorized_at=excluded.authorized_at,revoked_at=null;

  return vault_private.readiness_json(p_vault_id,v_account,p_device_id);
end;
$$;

create or replace function public.vault_key_readiness(
  p_vault_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare v_account uuid:=vault_private.current_account_id();
begin
  if v_account is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform vault_private.require_active_member(p_vault_id,v_account);
  perform vault_private.require_active_device(v_account,p_device_id);
  return vault_private.readiness_json(p_vault_id,v_account,p_device_id);
end;
$$;

create or replace function public.vault_key_device_envelopes(
  p_vault_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_rows jsonb;
begin
  if v_account is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform vault_private.require_authorized_device(p_vault_id,v_account,p_device_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'version',1,'accountId',e.account_id::text,'vaultId',e.vault_id::text,'deviceId',e.device_id::text,
    'keyGeneration',e.key_generation,'algorithm',e.algorithm,'publicKeyFingerprint',e.public_key_fingerprint,
    'ciphertext',e.ciphertext,'createdAt',e.created_at::text
  ) order by e.key_generation),'[]'::jsonb)
  into v_rows
  from vault_private.device_vault_key_envelopes e
  where e.vault_id=p_vault_id and e.account_id=v_account and e.device_id=p_device_id;
  return v_rows;
end;
$$;

create or replace function public.vault_key_recovery_envelope(
  p_vault_id uuid,
  p_key_generation integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_row vault_private.recovery_vault_key_envelopes%rowtype;
begin
  if v_account is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform vault_private.require_active_member(p_vault_id,v_account);
  select * into v_row from vault_private.recovery_vault_key_envelopes r
  where r.vault_id=p_vault_id and r.account_id=v_account and r.key_generation=p_key_generation;
  if not found then return null; end if;
  return jsonb_build_object(
    'version',1,'accountId',v_row.account_id::text,'vaultId',v_row.vault_id::text,
    'keyGeneration',v_row.key_generation,'algorithm',v_row.algorithm,
    'nonce',v_row.nonce,'ciphertext',v_row.ciphertext,'createdAt',v_row.created_at::text
  );
end;
$$;

create or replace function public.vault_key_request_access(
  p_vault_id uuid,
  p_device_id uuid,
  p_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_key vault_private.device_keys%rowtype;
  v_request vault_private.device_access_requests%rowtype;
  v_challenge text;
begin
  if v_account is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform vault_private.require_active_member(p_vault_id,v_account);
  perform vault_private.require_active_device(v_account,p_device_id);
  select * into v_key from vault_private.device_keys k
  where k.account_id=v_account and k.device_id=p_device_id;
  if not found or v_key.fingerprint<>p_fingerprint then raise exception 'Device key mismatch' using errcode='42501'; end if;

  select * into v_request
  from vault_private.device_access_requests r
  where r.vault_id=p_vault_id and r.account_id=v_account and r.device_id=p_device_id
    and r.confirmed_at is null and r.rejected_at is null and r.expires_at>now()
  order by r.created_at desc limit 1;
  if not found then
    v_challenge:=translate(rtrim(encode(extensions.gen_random_bytes(32),'base64'),'='),'+/','-_');
    insert into vault_private.device_access_requests(
      vault_id,account_id,device_id,public_key_fingerprint,challenge,expires_at
    ) values(
      p_vault_id,v_account,p_device_id,p_fingerprint,v_challenge,now()+interval '30 minutes'
    ) returning * into v_request;
  end if;

  return jsonb_build_object(
    'requestId',v_request.id::text,'vaultId',v_request.vault_id::text,'accountId',v_request.account_id::text,
    'deviceId',v_request.device_id::text,'algorithm',v_key.algorithm,'publicSpki',v_key.public_spki,
    'publicKeyFingerprint',v_key.fingerprint,'challenge',v_request.challenge,
    'status',case when v_request.confirmed_at is not null then 'confirmed'
                  when v_request.rejected_at is not null then 'rejected'
                  when v_request.expires_at<=now() then 'expired'
                  when v_request.approved_at is not null then 'approved' else 'pending' end,
    'createdAt',v_request.created_at::text,'expiresAt',v_request.expires_at::text
  );
end;
$$;

create or replace function public.vault_key_list_access_requests(
  p_vault_id uuid,
  p_approver_device_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_rows jsonb;
begin
  if v_account is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform vault_private.require_authorized_device(p_vault_id,v_account,p_approver_device_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'requestId',r.id::text,'vaultId',r.vault_id::text,'accountId',r.account_id::text,'deviceId',r.device_id::text,
    'algorithm',k.algorithm,'publicSpki',k.public_spki,'publicKeyFingerprint',k.fingerprint,'challenge',r.challenge,
    'status',case when r.confirmed_at is not null then 'confirmed'
                  when r.rejected_at is not null then 'rejected'
                  when r.expires_at<=now() then 'expired'
                  when r.approved_at is not null then 'approved' else 'pending' end,
    'createdAt',r.created_at::text,'expiresAt',r.expires_at::text
  ) order by r.created_at),'[]'::jsonb)
  into v_rows
  from vault_private.device_access_requests r
  join vault_private.device_keys k on k.account_id=r.account_id and k.device_id=r.device_id
  where r.vault_id=p_vault_id and r.account_id=v_account
    and r.confirmed_at is null and r.rejected_at is null and r.expires_at>now();
  return v_rows;
end;
$$;

create or replace function public.vault_key_approve_access_request(
  p_request_id uuid,
  p_approver_device_id uuid,
  p_key_generation integer,
  p_ciphertext text,
  p_expected_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_request vault_private.device_access_requests%rowtype;
  v_key vault_private.device_keys%rowtype;
  v_existing vault_private.device_vault_key_envelopes%rowtype;
begin
  if v_account is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_key_generation is null or p_key_generation<1 or p_ciphertext !~ '^[A-Za-z0-9_-]{512}$'
    or p_expected_confirmation !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'Invalid approval payload'; end if;
  select * into v_request from vault_private.device_access_requests r where r.id=p_request_id for update;
  if not found or v_request.account_id<>v_account or v_request.confirmed_at is not null
    or v_request.rejected_at is not null or v_request.expires_at<=now() then
    raise exception 'Access request is unavailable' using errcode='42501';
  end if;
  perform vault_private.require_authorized_device(v_request.vault_id,v_account,p_approver_device_id);
  select * into v_key from vault_private.device_keys k
  where k.account_id=v_account and k.device_id=v_request.device_id;
  if not found or v_key.fingerprint<>v_request.public_key_fingerprint then raise exception 'Target Device key changed' using errcode='42501'; end if;

  select * into v_existing from vault_private.device_vault_key_envelopes e
  where e.vault_id=v_request.vault_id and e.account_id=v_account
    and e.device_id=v_request.device_id and e.key_generation=p_key_generation;
  if found then
    if v_existing.ciphertext<>p_ciphertext or v_existing.public_key_fingerprint<>v_key.fingerprint then
      raise exception 'Target Device envelope identity is immutable';
    end if;
  else
    insert into vault_private.device_vault_key_envelopes(
      vault_id,account_id,device_id,key_generation,algorithm,public_key_fingerprint,ciphertext
    ) values(
      v_request.vault_id,v_account,v_request.device_id,p_key_generation,'RSA-OAEP-3072-SHA256',v_key.fingerprint,p_ciphertext
    );
  end if;
  update vault_private.device_access_requests
  set key_generation=p_key_generation,expected_confirmation=p_expected_confirmation,approved_at=coalesce(approved_at,now())
  where id=p_request_id;
  return jsonb_build_object('approved',true);
end;
$$;

create or replace function public.vault_key_pending_access(
  p_request_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_request vault_private.device_access_requests%rowtype;
  v_envelope vault_private.device_vault_key_envelopes%rowtype;
begin
  if v_account is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform vault_private.require_active_device(v_account,p_device_id);
  select * into v_request from vault_private.device_access_requests r
  where r.id=p_request_id and r.account_id=v_account and r.device_id=p_device_id
    and r.approved_at is not null and r.confirmed_at is null and r.rejected_at is null and r.expires_at>now();
  if not found then raise exception 'Approved access request is unavailable' using errcode='42501'; end if;
  select * into v_envelope from vault_private.device_vault_key_envelopes e
  where e.vault_id=v_request.vault_id and e.account_id=v_account and e.device_id=p_device_id
    and e.key_generation=v_request.key_generation;
  if not found then raise exception 'Approved Device envelope is missing'; end if;
  return jsonb_build_object(
    'requestId',v_request.id::text,'challenge',v_request.challenge,
    'envelope',jsonb_build_object(
      'version',1,'accountId',v_envelope.account_id::text,'vaultId',v_envelope.vault_id::text,
      'deviceId',v_envelope.device_id::text,'keyGeneration',v_envelope.key_generation,
      'algorithm',v_envelope.algorithm,'publicKeyFingerprint',v_envelope.public_key_fingerprint,
      'ciphertext',v_envelope.ciphertext,'createdAt',v_envelope.created_at::text
    )
  );
end;
$$;

create or replace function public.vault_key_confirm_access(
  p_request_id uuid,
  p_device_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_request vault_private.device_access_requests%rowtype;
begin
  if v_account is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_confirmation !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'Invalid Device confirmation'; end if;
  perform vault_private.require_active_device(v_account,p_device_id);
  select * into v_request from vault_private.device_access_requests r
  where r.id=p_request_id and r.account_id=v_account and r.device_id=p_device_id
    and r.approved_at is not null and r.confirmed_at is null and r.rejected_at is null and r.expires_at>now()
  for update;
  if not found or v_request.expected_confirmation is distinct from p_confirmation then
    raise exception 'Device key possession confirmation failed' using errcode='42501';
  end if;
  insert into vault_private.device_vault_access(vault_id,account_id,device_id,authorized_at,revoked_at)
  values(v_request.vault_id,v_account,p_device_id,now(),null)
  on conflict(vault_id,account_id,device_id) do update set authorized_at=excluded.authorized_at,revoked_at=null;
  update vault_private.device_access_requests set confirmed_at=now() where id=p_request_id;
  return vault_private.readiness_json(v_request.vault_id,v_account,p_device_id);
end;
$$;

create or replace function public.vault_key_recover_device(
  p_vault_id uuid,
  p_device_id uuid,
  p_key_generation integer,
  p_ciphertext text,
  p_public_key_fingerprint text,
  p_recovery_proof text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_key vault_private.device_keys%rowtype;
  v_recovery vault_private.recovery_vault_key_envelopes%rowtype;
  v_existing vault_private.device_vault_key_envelopes%rowtype;
begin
  if v_account is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform vault_private.require_active_member(p_vault_id,v_account);
  perform vault_private.require_active_device(v_account,p_device_id);
  if p_key_generation is null or p_key_generation<1 or p_ciphertext !~ '^[A-Za-z0-9_-]{512}$'
    or p_public_key_fingerprint !~ '^[A-Za-z0-9_-]{43}$' or p_recovery_proof !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'Invalid recovery Device payload';
  end if;
  select * into v_key from vault_private.device_keys k where k.account_id=v_account and k.device_id=p_device_id;
  if not found or v_key.fingerprint<>p_public_key_fingerprint then raise exception 'Registered Device key mismatch' using errcode='42501'; end if;
  select * into v_recovery from vault_private.recovery_vault_key_envelopes r
  where r.vault_id=p_vault_id and r.account_id=v_account and r.key_generation=p_key_generation;
  if not found or v_recovery.recovery_proof<>p_recovery_proof then
    raise exception 'Recovery Secret possession proof failed' using errcode='42501';
  end if;

  select * into v_existing from vault_private.device_vault_key_envelopes e
  where e.vault_id=p_vault_id and e.account_id=v_account and e.device_id=p_device_id and e.key_generation=p_key_generation;
  if found then
    if v_existing.ciphertext<>p_ciphertext or v_existing.public_key_fingerprint<>p_public_key_fingerprint then
      raise exception 'Device envelope identity is immutable';
    end if;
  else
    insert into vault_private.device_vault_key_envelopes(
      vault_id,account_id,device_id,key_generation,algorithm,public_key_fingerprint,ciphertext
    ) values(
      p_vault_id,v_account,p_device_id,p_key_generation,'RSA-OAEP-3072-SHA256',p_public_key_fingerprint,p_ciphertext
    );
  end if;
  insert into vault_private.device_vault_access(vault_id,account_id,device_id,authorized_at,revoked_at)
  values(p_vault_id,v_account,p_device_id,now(),null)
  on conflict(vault_id,account_id,device_id) do update set authorized_at=excluded.authorized_at,revoked_at=null;
  return vault_private.readiness_json(p_vault_id,v_account,p_device_id);
end;
$$;

-- RPC-only key material. SECURITY DEFINER is required because authenticated
-- clients have zero direct privileges on vault_private. Every function above
-- resolves auth.uid(), Account membership and Device state before access.
revoke all on function public.vault_key_register_device(uuid,uuid,text,text,text) from public,anon;
revoke all on function public.vault_key_initialize_vault(uuid,uuid,uuid,integer,text,text,text,text,text) from public,anon;
revoke all on function public.vault_key_readiness(uuid,uuid) from public,anon;
revoke all on function public.vault_key_device_envelopes(uuid,uuid) from public,anon;
revoke all on function public.vault_key_recovery_envelope(uuid,integer) from public,anon;
revoke all on function public.vault_key_request_access(uuid,uuid,text) from public,anon;
revoke all on function public.vault_key_list_access_requests(uuid,uuid) from public,anon;
revoke all on function public.vault_key_approve_access_request(uuid,uuid,integer,text,text) from public,anon;
revoke all on function public.vault_key_pending_access(uuid,uuid) from public,anon;
revoke all on function public.vault_key_confirm_access(uuid,uuid,text) from public,anon;
revoke all on function public.vault_key_recover_device(uuid,uuid,integer,text,text,text) from public,anon;

grant execute on function public.vault_key_register_device(uuid,uuid,text,text,text) to authenticated;
grant execute on function public.vault_key_initialize_vault(uuid,uuid,uuid,integer,text,text,text,text,text) to authenticated;
grant execute on function public.vault_key_readiness(uuid,uuid) to authenticated;
grant execute on function public.vault_key_device_envelopes(uuid,uuid) to authenticated;
grant execute on function public.vault_key_recovery_envelope(uuid,integer) to authenticated;
grant execute on function public.vault_key_request_access(uuid,uuid,text) to authenticated;
grant execute on function public.vault_key_list_access_requests(uuid,uuid) to authenticated;
grant execute on function public.vault_key_approve_access_request(uuid,uuid,integer,text,text) to authenticated;
grant execute on function public.vault_key_pending_access(uuid,uuid) to authenticated;
grant execute on function public.vault_key_confirm_access(uuid,uuid,text) to authenticated;
grant execute on function public.vault_key_recover_device(uuid,uuid,integer,text,text,text) to authenticated;


-- ---------------------------------------------------------------------------
-- I3 final multi-generation state and RPC contract.
--
-- The initial single-generation RPCs above are retained as migration-local
-- compatibility helpers, but the application uses the v2/multi-generation
-- functions below. The active generation is Vault state, not "max envelope
-- visible to this Device"; that distinction is required for safe rotation.
-- ---------------------------------------------------------------------------

create table if not exists vault_private.vault_key_state (
  vault_id uuid not null,
  account_id uuid not null,
  active_generation integer not null check (active_generation>=1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(vault_id,account_id),
  constraint vault_key_state_membership_fk
    foreign key(vault_id,account_id)
    references public.vault_memberships(vault_id,account_id)
    on delete cascade
);

-- Safe compatibility backfill if an earlier I3 draft created envelopes before
-- explicit Vault key state existed. I3 has not activated canonical v2 content,
-- so max retained recovery generation is the only possible active lineage.
insert into vault_private.vault_key_state(vault_id,account_id,active_generation)
select r.vault_id,r.account_id,max(r.key_generation)
from vault_private.recovery_vault_key_envelopes r
group by r.vault_id,r.account_id
on conflict(vault_id,account_id) do nothing;

alter table vault_private.vault_key_state enable row level security;
revoke all on vault_private.vault_key_state from public,anon,authenticated;

create or replace function vault_private.readiness_json(
  p_vault_id uuid,
  p_account_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_generation integer;
  v_device boolean := false;
  v_recovery boolean := false;
  v_authorized boolean := false;
begin
  select s.active_generation
  into v_generation
  from vault_private.vault_key_state s
  where s.vault_id=p_vault_id and s.account_id=p_account_id;

  if v_generation is not null then
    select exists(
      select 1 from vault_private.device_vault_key_envelopes e
      where e.vault_id=p_vault_id
        and e.account_id=p_account_id
        and e.device_id=p_device_id
        and e.key_generation=v_generation
    ) into v_device;

    select exists(
      select 1 from vault_private.recovery_vault_key_envelopes r
      where r.vault_id=p_vault_id
        and r.account_id=p_account_id
        and r.key_generation=v_generation
    ) into v_recovery;
  end if;

  select exists(
    select 1
    from vault_private.device_vault_access a
    join public.vault_cloud_devices d
      on d.account_id=a.account_id and d.id=a.device_id
    where a.vault_id=p_vault_id
      and a.account_id=p_account_id
      and a.device_id=p_device_id
      and a.revoked_at is null
      and d.revoked_at is null
  ) into v_authorized;

  return jsonb_build_object(
    'vaultId',p_vault_id::text,
    'deviceId',p_device_id::text,
    'keyGeneration',v_generation,
    'deviceEnvelope',coalesce(v_device,false),
    'recoveryEnvelope',coalesce(v_recovery,false),
    'deviceAuthorized',coalesce(v_authorized,false),
    'ready',coalesce(v_device,false)
      and coalesce(v_recovery,false)
      and coalesce(v_authorized,false)
  );
end;
$$;

create or replace function public.vault_key_initialize_vault(
  p_account_id uuid,
  p_vault_id uuid,
  p_device_id uuid,
  p_key_generation integer,
  p_device_ciphertext text,
  p_public_key_fingerprint text,
  p_recovery_nonce text,
  p_recovery_ciphertext text,
  p_recovery_proof text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_key vault_private.device_keys%rowtype;
  v_state vault_private.vault_key_state%rowtype;
  v_existing_device vault_private.device_vault_key_envelopes%rowtype;
  v_existing_recovery vault_private.recovery_vault_key_envelopes%rowtype;
begin
  if v_account is null or p_account_id<>v_account then
    raise exception 'Account mismatch' using errcode='42501';
  end if;
  if p_key_generation is null or p_key_generation<1
    or p_device_ciphertext !~ '^[A-Za-z0-9_-]{512}$'
    or p_public_key_fingerprint !~ '^[A-Za-z0-9_-]{43}$'
    or p_recovery_nonce !~ '^[A-Za-z0-9_-]{16}$'
    or p_recovery_ciphertext !~ '^[A-Za-z0-9_-]{64}$'
    or p_recovery_proof !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'Invalid Vault key envelope payload';
  end if;

  perform vault_private.require_active_member(p_vault_id,v_account);
  perform vault_private.require_active_device(v_account,p_device_id);

  select * into v_key
  from vault_private.device_keys k
  where k.account_id=v_account and k.device_id=p_device_id;
  if not found or v_key.fingerprint<>p_public_key_fingerprint then
    raise exception 'Registered Device key mismatch' using errcode='42501';
  end if;

  select * into v_state
  from vault_private.vault_key_state s
  where s.vault_id=p_vault_id and s.account_id=v_account
  for update;

  if found and v_state.active_generation<>p_key_generation then
    raise exception 'Vault key state is already initialized at another generation';
  end if;

  select * into v_existing_device
  from vault_private.device_vault_key_envelopes e
  where e.vault_id=p_vault_id
    and e.account_id=v_account
    and e.device_id=p_device_id
    and e.key_generation=p_key_generation;
  if found then
    if v_existing_device.ciphertext<>p_device_ciphertext
      or v_existing_device.public_key_fingerprint<>p_public_key_fingerprint then
      raise exception 'Device envelope identity is immutable';
    end if;
  else
    insert into vault_private.device_vault_key_envelopes(
      vault_id,account_id,device_id,key_generation,algorithm,public_key_fingerprint,ciphertext
    ) values(
      p_vault_id,v_account,p_device_id,p_key_generation,
      'RSA-OAEP-3072-SHA256',p_public_key_fingerprint,p_device_ciphertext
    );
  end if;

  select * into v_existing_recovery
  from vault_private.recovery_vault_key_envelopes r
  where r.vault_id=p_vault_id
    and r.account_id=v_account
    and r.key_generation=p_key_generation;
  if found then
    if v_existing_recovery.nonce<>p_recovery_nonce
      or v_existing_recovery.ciphertext<>p_recovery_ciphertext
      or v_existing_recovery.recovery_proof<>p_recovery_proof then
      raise exception 'Recovery envelope identity is immutable';
    end if;
  else
    insert into vault_private.recovery_vault_key_envelopes(
      vault_id,account_id,key_generation,algorithm,nonce,ciphertext,recovery_proof
    ) values(
      p_vault_id,v_account,p_key_generation,'A256GCM',
      p_recovery_nonce,p_recovery_ciphertext,p_recovery_proof
    );
  end if;

  if v_state.vault_id is null then
    insert into vault_private.vault_key_state(vault_id,account_id,active_generation)
    values(p_vault_id,v_account,p_key_generation);
  end if;

  insert into vault_private.device_vault_access(
    vault_id,account_id,device_id,authorized_at,revoked_at
  ) values(
    p_vault_id,v_account,p_device_id,now(),null
  )
  on conflict(vault_id,account_id,device_id) do update
    set authorized_at=excluded.authorized_at,revoked_at=null;

  return vault_private.readiness_json(p_vault_id,v_account,p_device_id);
end;
$$;

create or replace function public.vault_key_recovery_envelopes(
  p_vault_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_rows jsonb;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  perform vault_private.require_active_member(p_vault_id,v_account);

  select coalesce(jsonb_agg(jsonb_build_object(
    'version',1,
    'accountId',r.account_id::text,
    'vaultId',r.vault_id::text,
    'keyGeneration',r.key_generation,
    'algorithm',r.algorithm,
    'nonce',r.nonce,
    'ciphertext',r.ciphertext,
    'createdAt',r.created_at::text
  ) order by r.key_generation),'[]'::jsonb)
  into v_rows
  from vault_private.recovery_vault_key_envelopes r
  where r.vault_id=p_vault_id and r.account_id=v_account;

  return v_rows;
end;
$$;

create or replace function public.vault_key_authorized_devices(
  p_vault_id uuid,
  p_actor_device_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_rows jsonb;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  perform vault_private.require_authorized_device(
    p_vault_id,v_account,p_actor_device_id
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'accountId',k.account_id::text,
    'deviceId',k.device_id::text,
    'algorithm',k.algorithm,
    'publicSpki',k.public_spki,
    'fingerprint',k.fingerprint
  ) order by k.device_id),'[]'::jsonb)
  into v_rows
  from vault_private.device_vault_access a
  join public.vault_cloud_devices d
    on d.account_id=a.account_id and d.id=a.device_id
  join vault_private.device_keys k
    on k.account_id=a.account_id and k.device_id=a.device_id
  where a.vault_id=p_vault_id
    and a.account_id=v_account
    and a.revoked_at is null
    and d.revoked_at is null;

  return v_rows;
end;
$$;

create or replace function public.vault_key_approve_access_request_v2(
  p_request_id uuid,
  p_approver_device_id uuid,
  p_active_generation integer,
  p_envelopes jsonb,
  p_expected_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_request vault_private.device_access_requests%rowtype;
  v_key vault_private.device_keys%rowtype;
  v_state vault_private.vault_key_state%rowtype;
  v_item jsonb;
  v_generation integer;
  v_existing vault_private.device_vault_key_envelopes%rowtype;
  v_seen integer:=0;
  v_expected integer:=0;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if p_active_generation is null or p_active_generation<1
    or jsonb_typeof(p_envelopes)<>'array'
    or jsonb_array_length(p_envelopes)<1
    or p_expected_confirmation !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'Invalid multi-generation approval payload';
  end if;

  select * into v_request
  from vault_private.device_access_requests r
  where r.id=p_request_id
  for update;
  if not found
    or v_request.account_id<>v_account
    or v_request.confirmed_at is not null
    or v_request.rejected_at is not null
    or v_request.expires_at<=now() then
    raise exception 'Access request is unavailable' using errcode='42501';
  end if;

  perform vault_private.require_authorized_device(
    v_request.vault_id,v_account,p_approver_device_id
  );

  select * into v_state
  from vault_private.vault_key_state s
  where s.vault_id=v_request.vault_id and s.account_id=v_account
  for update;
  if not found or v_state.active_generation<>p_active_generation then
    raise exception 'Vault active key generation changed';
  end if;

  select * into v_key
  from vault_private.device_keys k
  where k.account_id=v_account and k.device_id=v_request.device_id;
  if not found or v_key.fingerprint<>v_request.public_key_fingerprint then
    raise exception 'Target Device key changed' using errcode='42501';
  end if;

  select count(*) into v_expected
  from vault_private.recovery_vault_key_envelopes r
  where r.vault_id=v_request.vault_id and r.account_id=v_account;

  if jsonb_array_length(p_envelopes)<>v_expected then
    raise exception 'Approval must wrap every retained Vault-key generation';
  end if;

  for v_item in select value from jsonb_array_elements(p_envelopes)
  loop
    begin
      v_generation:=(v_item->>'keyGeneration')::integer;
    exception when others then
      raise exception 'Invalid Device envelope generation';
    end;

    if v_generation<1
      or (v_item->>'accountId') is distinct from v_account::text
      or (v_item->>'vaultId') is distinct from v_request.vault_id::text
      or (v_item->>'deviceId') is distinct from v_request.device_id::text
      or (v_item->>'algorithm') is distinct from 'RSA-OAEP-3072-SHA256'
      or (v_item->>'publicKeyFingerprint') is distinct from v_key.fingerprint
      or coalesce(v_item->>'ciphertext','') !~ '^[A-Za-z0-9_-]{512}$'
      or not exists(
        select 1
        from vault_private.recovery_vault_key_envelopes r
        where r.vault_id=v_request.vault_id
          and r.account_id=v_account
          and r.key_generation=v_generation
      ) then
      raise exception 'Invalid or unexpected Device envelope in approval';
    end if;

    select * into v_existing
    from vault_private.device_vault_key_envelopes e
    where e.vault_id=v_request.vault_id
      and e.account_id=v_account
      and e.device_id=v_request.device_id
      and e.key_generation=v_generation;

    if found then
      if v_existing.ciphertext<>(v_item->>'ciphertext')
        or v_existing.public_key_fingerprint<>v_key.fingerprint then
        raise exception 'Target Device envelope identity is immutable';
      end if;
    else
      insert into vault_private.device_vault_key_envelopes(
        vault_id,account_id,device_id,key_generation,
        algorithm,public_key_fingerprint,ciphertext
      ) values(
        v_request.vault_id,v_account,v_request.device_id,v_generation,
        'RSA-OAEP-3072-SHA256',v_key.fingerprint,v_item->>'ciphertext'
      );
    end if;
    v_seen:=v_seen+1;
  end loop;

  if v_seen<>v_expected or not exists(
    select 1 from jsonb_array_elements(p_envelopes) item
    where (item->>'keyGeneration')::integer=p_active_generation
  ) then
    raise exception 'Approval envelope set is incomplete';
  end if;

  -- Duplicate generations are excluded by comparing distinct generation count.
  if (
    select count(distinct (item->>'keyGeneration')::integer)
    from jsonb_array_elements(p_envelopes) item
  )<>v_expected then
    raise exception 'Approval contains duplicate key generations';
  end if;

  update vault_private.device_access_requests
  set key_generation=p_active_generation,
      expected_confirmation=p_expected_confirmation,
      approved_at=coalesce(approved_at,now())
  where id=p_request_id;

  return jsonb_build_object('approved',true);
end;
$$;

create or replace function public.vault_key_pending_access_v2(
  p_request_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_request vault_private.device_access_requests%rowtype;
  v_rows jsonb;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  perform vault_private.require_active_device(v_account,p_device_id);

  select * into v_request
  from vault_private.device_access_requests r
  where r.id=p_request_id
    and r.account_id=v_account
    and r.device_id=p_device_id
    and r.approved_at is not null
    and r.confirmed_at is null
    and r.rejected_at is null
    and r.expires_at>now();
  if not found or v_request.key_generation is null then
    raise exception 'Approved access request is unavailable' using errcode='42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'version',1,
    'accountId',e.account_id::text,
    'vaultId',e.vault_id::text,
    'deviceId',e.device_id::text,
    'keyGeneration',e.key_generation,
    'algorithm',e.algorithm,
    'publicKeyFingerprint',e.public_key_fingerprint,
    'ciphertext',e.ciphertext,
    'createdAt',e.created_at::text
  ) order by e.key_generation),'[]'::jsonb)
  into v_rows
  from vault_private.device_vault_key_envelopes e
  where e.vault_id=v_request.vault_id
    and e.account_id=v_account
    and e.device_id=p_device_id;

  return jsonb_build_object(
    'requestId',v_request.id::text,
    'challenge',v_request.challenge,
    'activeGeneration',v_request.key_generation,
    'envelopes',v_rows
  );
end;
$$;

create or replace function public.vault_key_recover_device_v2(
  p_vault_id uuid,
  p_device_id uuid,
  p_active_generation integer,
  p_envelopes jsonb,
  p_recovery_proofs jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_key vault_private.device_keys%rowtype;
  v_state vault_private.vault_key_state%rowtype;
  v_item jsonb;
  v_generation integer;
  v_expected_proof text;
  v_existing vault_private.device_vault_key_envelopes%rowtype;
  v_expected integer:=0;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  perform vault_private.require_active_member(p_vault_id,v_account);
  perform vault_private.require_active_device(v_account,p_device_id);

  if p_active_generation is null or p_active_generation<1
    or jsonb_typeof(p_envelopes)<>'array'
    or jsonb_typeof(p_recovery_proofs)<>'array' then
    raise exception 'Invalid multi-generation recovery payload';
  end if;

  select * into v_state
  from vault_private.vault_key_state s
  where s.vault_id=p_vault_id and s.account_id=v_account
  for update;
  if not found or v_state.active_generation<>p_active_generation then
    raise exception 'Recovery active generation mismatch';
  end if;

  select * into v_key
  from vault_private.device_keys k
  where k.account_id=v_account and k.device_id=p_device_id;
  if not found then
    raise exception 'Registered Device key is missing' using errcode='42501';
  end if;

  select count(*) into v_expected
  from vault_private.recovery_vault_key_envelopes r
  where r.vault_id=p_vault_id and r.account_id=v_account;

  if jsonb_array_length(p_envelopes)<>v_expected
    or jsonb_array_length(p_recovery_proofs)<>v_expected then
    raise exception 'Recovery must cover every retained Vault-key generation';
  end if;

  if (
    select count(distinct (item->>'keyGeneration')::integer)
    from jsonb_array_elements(p_envelopes) item
  )<>v_expected or (
    select count(distinct (item->>'keyGeneration')::integer)
    from jsonb_array_elements(p_recovery_proofs) item
  )<>v_expected then
    raise exception 'Recovery contains duplicate key generations';
  end if;

  for v_item in select value from jsonb_array_elements(p_envelopes)
  loop
    begin
      v_generation:=(v_item->>'keyGeneration')::integer;
    exception when others then
      raise exception 'Invalid recovery Device-envelope generation';
    end;

    if (v_item->>'accountId') is distinct from v_account::text
      or (v_item->>'vaultId') is distinct from p_vault_id::text
      or (v_item->>'deviceId') is distinct from p_device_id::text
      or (v_item->>'algorithm') is distinct from 'RSA-OAEP-3072-SHA256'
      or (v_item->>'publicKeyFingerprint') is distinct from v_key.fingerprint
      or coalesce(v_item->>'ciphertext','') !~ '^[A-Za-z0-9_-]{512}$' then
      raise exception 'Invalid Device envelope in recovery';
    end if;

    select r.recovery_proof
    into v_expected_proof
    from vault_private.recovery_vault_key_envelopes r
    where r.vault_id=p_vault_id
      and r.account_id=v_account
      and r.key_generation=v_generation;
    if not found then
      raise exception 'Unexpected recovery key generation';
    end if;

    if not exists(
      select 1
      from jsonb_array_elements(p_recovery_proofs) proof
      where (proof->>'keyGeneration')::integer=v_generation
        and proof->>'recoveryProof'=v_expected_proof
    ) then
      raise exception 'Recovery Secret possession proof failed' using errcode='42501';
    end if;

    select * into v_existing
    from vault_private.device_vault_key_envelopes e
    where e.vault_id=p_vault_id
      and e.account_id=v_account
      and e.device_id=p_device_id
      and e.key_generation=v_generation;
    if found then
      if v_existing.ciphertext<>(v_item->>'ciphertext')
        or v_existing.public_key_fingerprint<>v_key.fingerprint then
        raise exception 'Device envelope identity is immutable';
      end if;
    else
      insert into vault_private.device_vault_key_envelopes(
        vault_id,account_id,device_id,key_generation,
        algorithm,public_key_fingerprint,ciphertext
      ) values(
        p_vault_id,v_account,p_device_id,v_generation,
        'RSA-OAEP-3072-SHA256',v_key.fingerprint,v_item->>'ciphertext'
      );
    end if;
  end loop;

  insert into vault_private.device_vault_access(
    vault_id,account_id,device_id,authorized_at,revoked_at
  ) values(
    p_vault_id,v_account,p_device_id,now(),null
  )
  on conflict(vault_id,account_id,device_id) do update
    set authorized_at=excluded.authorized_at,revoked_at=null;

  return vault_private.readiness_json(p_vault_id,v_account,p_device_id);
end;
$$;

create or replace function public.vault_key_rotate_vmk(
  p_vault_id uuid,
  p_actor_device_id uuid,
  p_from_generation integer,
  p_to_generation integer,
  p_device_envelopes jsonb,
  p_recovery jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_state vault_private.vault_key_state%rowtype;
  v_expected_devices integer:=0;
  v_item jsonb;
  v_device_id uuid;
  v_key vault_private.device_keys%rowtype;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  perform vault_private.require_authorized_device(
    p_vault_id,v_account,p_actor_device_id
  );

  if p_from_generation is null or p_from_generation<1
    or p_to_generation<>p_from_generation+1
    or jsonb_typeof(p_device_envelopes)<>'array'
    or jsonb_array_length(p_device_envelopes)<1
    or jsonb_typeof(p_recovery)<>'object' then
    raise exception 'Invalid VMK rotation payload';
  end if;

  select * into v_state
  from vault_private.vault_key_state s
  where s.vault_id=p_vault_id and s.account_id=v_account
  for update;
  if not found or v_state.active_generation<>p_from_generation then
    raise exception 'Vault active key generation changed';
  end if;

  select count(*) into v_expected_devices
  from vault_private.device_vault_access a
  join public.vault_cloud_devices d
    on d.account_id=a.account_id and d.id=a.device_id
  join vault_private.device_keys k
    on k.account_id=a.account_id and k.device_id=a.device_id
  where a.vault_id=p_vault_id
    and a.account_id=v_account
    and a.revoked_at is null
    and d.revoked_at is null;

  if jsonb_array_length(p_device_envelopes)<>v_expected_devices then
    raise exception 'VMK rotation must wrap every authorized Device';
  end if;

  if (
    select count(distinct item->>'deviceId')
    from jsonb_array_elements(p_device_envelopes) item
  )<>v_expected_devices then
    raise exception 'VMK rotation contains duplicate Devices';
  end if;

  for v_item in select value from jsonb_array_elements(p_device_envelopes)
  loop
    begin
      v_device_id:=(v_item->>'deviceId')::uuid;
    exception when others then
      raise exception 'Invalid VMK rotation DeviceId';
    end;

    select k.* into v_key
    from vault_private.device_vault_access a
    join public.vault_cloud_devices d
      on d.account_id=a.account_id and d.id=a.device_id
    join vault_private.device_keys k
      on k.account_id=a.account_id and k.device_id=a.device_id
    where a.vault_id=p_vault_id
      and a.account_id=v_account
      and a.device_id=v_device_id
      and a.revoked_at is null
      and d.revoked_at is null;

    if not found
      or (v_item->>'accountId') is distinct from v_account::text
      or (v_item->>'vaultId') is distinct from p_vault_id::text
      or (v_item->>'keyGeneration')::integer<>p_to_generation
      or (v_item->>'algorithm') is distinct from 'RSA-OAEP-3072-SHA256'
      or (v_item->>'publicKeyFingerprint') is distinct from v_key.fingerprint
      or coalesce(v_item->>'ciphertext','') !~ '^[A-Za-z0-9_-]{512}$' then
      raise exception 'Invalid Device envelope in VMK rotation';
    end if;

    insert into vault_private.device_vault_key_envelopes(
      vault_id,account_id,device_id,key_generation,
      algorithm,public_key_fingerprint,ciphertext
    ) values(
      p_vault_id,v_account,v_device_id,p_to_generation,
      'RSA-OAEP-3072-SHA256',v_key.fingerprint,v_item->>'ciphertext'
    );
  end loop;

  if (p_recovery->>'accountId') is distinct from v_account::text
    or (p_recovery->>'vaultId') is distinct from p_vault_id::text
    or (p_recovery->>'keyGeneration')::integer<>p_to_generation
    or (p_recovery->>'algorithm') is distinct from 'A256GCM'
    or coalesce(p_recovery->>'nonce','') !~ '^[A-Za-z0-9_-]{16}$'
    or coalesce(p_recovery->>'ciphertext','') !~ '^[A-Za-z0-9_-]{64}$'
    or coalesce(p_recovery->>'recoveryProof','') !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'Invalid Recovery envelope in VMK rotation';
  end if;

  insert into vault_private.recovery_vault_key_envelopes(
    vault_id,account_id,key_generation,algorithm,nonce,ciphertext,recovery_proof
  ) values(
    p_vault_id,v_account,p_to_generation,'A256GCM',
    p_recovery->>'nonce',
    p_recovery->>'ciphertext',
    p_recovery->>'recoveryProof'
  );

  update vault_private.vault_key_state
  set active_generation=p_to_generation,updated_at=now()
  where vault_id=p_vault_id
    and account_id=v_account
    and active_generation=p_from_generation;
  if not found then
    raise exception 'Vault active key generation changed';
  end if;

  return vault_private.readiness_json(
    p_vault_id,v_account,p_actor_device_id
  );
end;
$$;

create or replace function public.vault_key_rotate_recovery(
  p_vault_id uuid,
  p_actor_device_id uuid,
  p_replacements jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_account uuid:=vault_private.current_account_id();
  v_expected integer:=0;
  v_item jsonb;
  v_generation integer;
begin
  if v_account is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  perform vault_private.require_authorized_device(
    p_vault_id,v_account,p_actor_device_id
  );

  if jsonb_typeof(p_replacements)<>'array' then
    raise exception 'Invalid Recovery rotation payload';
  end if;

  select count(*) into v_expected
  from vault_private.recovery_vault_key_envelopes r
  where r.vault_id=p_vault_id and r.account_id=v_account;

  if v_expected<1 or jsonb_array_length(p_replacements)<>v_expected then
    raise exception 'Recovery rotation must rewrap every retained generation';
  end if;

  if (
    select count(distinct (item->>'keyGeneration')::integer)
    from jsonb_array_elements(p_replacements) item
  )<>v_expected then
    raise exception 'Recovery rotation contains duplicate generations';
  end if;

  for v_item in select value from jsonb_array_elements(p_replacements)
  loop
    begin
      v_generation:=(v_item->>'keyGeneration')::integer;
    exception when others then
      raise exception 'Invalid Recovery rotation generation';
    end;

    if (v_item->>'accountId') is distinct from v_account::text
      or (v_item->>'vaultId') is distinct from p_vault_id::text
      or (v_item->>'algorithm') is distinct from 'A256GCM'
      or coalesce(v_item->>'nonce','') !~ '^[A-Za-z0-9_-]{16}$'
      or coalesce(v_item->>'ciphertext','') !~ '^[A-Za-z0-9_-]{64}$'
      or coalesce(v_item->>'recoveryProof','') !~ '^[A-Za-z0-9_-]{43}$'
      or not exists(
        select 1
        from vault_private.recovery_vault_key_envelopes r
        where r.vault_id=p_vault_id
          and r.account_id=v_account
          and r.key_generation=v_generation
      ) then
      raise exception 'Invalid Recovery replacement';
    end if;

    update vault_private.recovery_vault_key_envelopes
    set nonce=v_item->>'nonce',
        ciphertext=v_item->>'ciphertext',
        recovery_proof=v_item->>'recoveryProof',
        created_at=now()
    where vault_id=p_vault_id
      and account_id=v_account
      and key_generation=v_generation;
  end loop;

  return jsonb_build_object('rotated',true);
end;
$$;

-- Legacy single-generation approval/recovery RPCs are not part of the I3
-- application contract after this migration.
revoke execute on function public.vault_key_approve_access_request(uuid,uuid,integer,text,text)
  from authenticated;
revoke execute on function public.vault_key_pending_access(uuid,uuid)
  from authenticated;
revoke execute on function public.vault_key_recover_device(uuid,uuid,integer,text,text,text)
  from authenticated;

revoke all on function public.vault_key_recovery_envelopes(uuid) from public,anon;
revoke all on function public.vault_key_authorized_devices(uuid,uuid) from public,anon;
revoke all on function public.vault_key_approve_access_request_v2(uuid,uuid,integer,jsonb,text) from public,anon;
revoke all on function public.vault_key_pending_access_v2(uuid,uuid) from public,anon;
revoke all on function public.vault_key_recover_device_v2(uuid,uuid,integer,jsonb,jsonb) from public,anon;
revoke all on function public.vault_key_rotate_vmk(uuid,uuid,integer,integer,jsonb,jsonb) from public,anon;
revoke all on function public.vault_key_rotate_recovery(uuid,uuid,jsonb) from public,anon;

grant execute on function public.vault_key_recovery_envelopes(uuid) to authenticated;
grant execute on function public.vault_key_authorized_devices(uuid,uuid) to authenticated;
grant execute on function public.vault_key_approve_access_request_v2(uuid,uuid,integer,jsonb,text) to authenticated;
grant execute on function public.vault_key_pending_access_v2(uuid,uuid) to authenticated;
grant execute on function public.vault_key_recover_device_v2(uuid,uuid,integer,jsonb,jsonb) to authenticated;
grant execute on function public.vault_key_rotate_vmk(uuid,uuid,integer,integer,jsonb,jsonb) to authenticated;
grant execute on function public.vault_key_rotate_recovery(uuid,uuid,jsonb) to authenticated;
