-- 메일 폴링 스케줄러를 Supabase 내장 pg_cron으로 이전.
--
-- 배경: Vercel Hobby는 크론이 하루 2회 제한, GitHub Actions는 schedule 트리거가
-- 등록만 되고 실제로 발화하지 않는 문제(2026-07-19, 3시간+ 무발화 실측)가 있어
-- 외부 스케줄러 대신 이미 쓰고 있는 Supabase의 pg_cron + pg_net으로 5분마다
-- 배포된 크론 엔드포인트를 직접 호출한다.
--
-- CRON_SECRET은 공개 저장소에 커밋되면 안 되므로 이 파일에 넣지 않는다 —
-- Vault에 별도로 저장하고(set_polling_secret RPC를 service_role로 1회 호출),
-- 매 실행 시 Vault에서 꺼내 Authorization 헤더로 쓴다.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 시크릿 저장용(1회 설정). service_role 전용 — 직원 세션(authenticated)에서는 호출 불가.
create or replace function public.set_polling_secret(p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'polling_cron_secret';
  if v_id is null then
    perform vault.create_secret(p_secret, 'polling_cron_secret');
  else
    perform vault.update_secret(v_id, p_secret);
  end if;
end;
$$;

revoke execute on function public.set_polling_secret(text) from public, anon, authenticated;

-- 3개 크론 엔드포인트 호출. pg_net은 비동기 큐라 응답을 기다리지 않는다(발사 후 잊기) —
-- 결과 확인은 대시보드의 "마지막 동기화" 칩과 ingest_log가 담당.
create or replace function public.invoke_pollers()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
  v_headers jsonb;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'polling_cron_secret';

  if v_secret is null then
    raise warning 'polling_cron_secret이 Vault에 없음 — set_polling_secret 먼저 호출 필요';
    return;
  end if;

  v_headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret);

  perform net.http_get(
    url := 'https://reservation-dashboard-pi.vercel.app/api/cron/poll-naver',
    headers := v_headers,
    timeout_milliseconds := 120000
  );
  perform net.http_get(
    url := 'https://reservation-dashboard-pi.vercel.app/api/cron/poll-gmail',
    headers := v_headers,
    timeout_milliseconds := 120000
  );
  perform net.http_get(
    url := 'https://reservation-dashboard-pi.vercel.app/api/cron/reconcile-stayfolio',
    headers := v_headers,
    timeout_milliseconds := 120000
  );
end;
$$;

revoke execute on function public.invoke_pollers() from public, anon, authenticated;

-- 5분마다 실행. 같은 이름의 잡이 있으면 갱신(unschedule 후 재등록).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'poll-reservation-mail') then
    perform cron.unschedule('poll-reservation-mail');
  end if;
  perform cron.schedule(
    'poll-reservation-mail',
    '*/5 * * * *',
    'select public.invoke_pollers()'
  );
end;
$$;
