-- 0029 검증 — 0029 적용 후 실행. 테스트 행을 만들고 rollback 하므로 운영 데이터 무변경.
-- 성공 시 'ALL PASSED' 한 행, 실패 시 ERROR: FAIL: <라벨>.
begin;

do $$
declare
  v_id uuid;
  v_s subscriptions%rowtype;
begin
  insert into subscriptions (name, plan_months, amount, start_month, end_month)
  values ('검증용', 4, 100000, '2026-11', '2027-02') returning id into v_id;

  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'pending' then raise exception 'FAIL: 기본 상태 pending'; end if;

  perform confirm_subscription(v_id);
  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'confirmed' or v_s.confirmed_at is null then raise exception 'FAIL: 입금확인'; end if;

  perform end_subscription(v_id, true);
  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'ended' or v_s.ended_at is null then raise exception 'FAIL: 종료'; end if;

  perform end_subscription(v_id, false);
  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'confirmed' or v_s.ended_at is not null then raise exception 'FAIL: 종료 해제'; end if;

  perform unconfirm_subscription(v_id);
  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'pending' or v_s.confirmed_at is not null then raise exception 'FAIL: 입금확인 되돌리기'; end if;

  -- pending 에 종료 시도는 무시되어야 한다
  perform end_subscription(v_id, true);
  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'pending' then raise exception 'FAIL: pending 은 종료 불가'; end if;

  begin
    insert into subscriptions (name, plan_months, amount, start_month, end_month)
    values ('잘못', 6, 1, '2026-11', '2027-04');
    raise exception 'FAIL: plan_months 6 이 허용됨';
  exception when check_violation then null; end;

  begin
    insert into subscriptions (name, plan_months, amount, start_month, end_month)
    values ('잘못', 4, 1, '2026-11', '2026-10');
    raise exception 'FAIL: end < start 가 허용됨';
  exception when check_violation then null; end;

  insert into subscription_shipments (subscription_id, month, memo) values (v_id, '2026-11', '책 A / 사과');
  begin
    insert into subscription_shipments (subscription_id, month, memo) values (v_id, '2026-11', '중복');
    raise exception 'FAIL: (구독, 월) 중복이 허용됨';
  exception when unique_violation then null; end;

  delete from subscriptions where id = v_id;
  if exists (select 1 from subscription_shipments where subscription_id = v_id) then
    raise exception 'FAIL: 구독 삭제 시 발송 메모 cascade';
  end if;
end $$;

select 'ALL PASSED' as result;
rollback;
