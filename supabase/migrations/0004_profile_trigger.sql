-- 신규 계정(Supabase 대시보드에서 4인 생성) 최초 가입 시 profiles 행 자동 생성.
-- 로그인 액션(app/login/actions.ts)의 upsert는 이 트리거가 없던 구계정에 대한 보정용 폴백.

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
