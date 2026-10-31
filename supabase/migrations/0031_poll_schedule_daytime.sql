-- 메일 폴링 주기 축소: 5분마다 → 낮 30분마다, 밤에는 쉼.
--
-- 배경: Vercel Pro 전환 전 Fluid Active CPU 무료 한도(월 4시간)를 숙박통합사이트의
-- 폴링 호출이 96% 차지해 초과. 호출 수를 줄여 CPU를 절약한다.
--
-- pg_cron 시간대는 GMT(UTC). 한국시간(KST = UTC+9) 06:00~21:30에 30분마다 실행하고
-- 22:00~05:59에는 실행하지 않는다 (밤사이 예약은 아침 06:00 폴링에서 일괄 반영).
--   UTC 21~23시 = KST 06:00~08:30
--   UTC 00~12시 = KST 09:00~21:30
--
-- 운영 DB에는 2026-11-01 SQL Editor에서 이미 적용함. 새 DB를 만들 때 0019 이후
-- 이 파일을 적용하면 같은 상태가 된다. 재실행해도 안전(잡 이름으로 찾아 갱신).

do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'poll-reservation-mail';
  if v_jobid is null then
    raise warning 'poll-reservation-mail 잡이 없음 — 0019를 먼저 적용해야 함';
    return;
  end if;
  perform cron.alter_job(v_jobid, schedule := '0,30 21-23,0-12 * * *');
end;
$$;
