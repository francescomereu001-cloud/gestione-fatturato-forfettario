-- PR12.1: assign ownerless legacy invoices only in the single-user production profile.
-- Safety guard: abort rather than guessing ownership when more than one Auth user exists.
do $$
declare
  owner_id uuid;
  user_count integer;
begin
  select count(*) into user_count from auth.users;

  if user_count <> 1 then
    raise exception 'legacy invoice ownership backfill requires exactly one auth user; found %', user_count;
  end if;

  select id into owner_id from auth.users limit 1;

  update public.invoices
  set user_id = owner_id
  where user_id is null;
end
$$;
