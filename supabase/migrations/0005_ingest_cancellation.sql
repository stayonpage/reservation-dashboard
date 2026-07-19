-- 취소 알림 처리: 네이버는 접수/취소를 같은 예약번호로 별도 메일 발송한다(2026-07 실데이터 확인).
-- 기존 ingest_reservation은 재수신 시 status를 절대 안 건드리는 설계(워크플로우 보존)라,
-- 취소 메일이 와도 예약이 'new'로 남는 유령이 생겼다. p_cancelled 파라미터를 추가해
-- 취소만은 status를 덮어쓰고, 해당 예약의 pending 블록태스크를 자동 skip한다.

-- 시그니처가 바뀌므로 구버전을 제거하고 재생성(권한도 재적용).
drop function if exists ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb
);

create or replace function ingest_reservation(
  p_channel                channel,
  p_channel_reservation_id text,
  p_guest_name             text,
  p_guest_phone            text,
  p_room_name              text,
  p_check_in               date,
  p_check_out              date,
  p_amount                 integer,
  p_options                jsonb,
  p_payment_method         payment_method,
  p_payment_status         payment_status,
  p_raw                    jsonb,
  p_cancelled              boolean default false
) returns uuid
language plpgsql
security definer
as $$
declare
  v_id            uuid;
  v_is_new        boolean;
  v_was_cancelled boolean;
  v_status        reservation_status;
begin
  v_status := case
    when p_cancelled then 'cancelled'
    when p_payment_status = 'paid' then 'confirmed'
    else 'new'
  end::reservation_status;

  -- 기존 행의 취소 여부(전환 감지용) — upsert 전에 확인.
  select (status = 'cancelled') into v_was_cancelled
    from reservations
   where channel = p_channel and channel_reservation_id = p_channel_reservation_id;

  insert into reservations as r (
    channel, channel_reservation_id, guest_name, guest_phone, room_name,
    check_in, check_out, amount, options,
    payment_method, payment_status, status,
    cancelled_at, raw_payload
  ) values (
    p_channel, p_channel_reservation_id, p_guest_name, p_guest_phone, p_room_name,
    p_check_in, p_check_out, p_amount, coalesce(p_options, '[]'::jsonb),
    p_payment_method, p_payment_status, v_status,
    case when p_cancelled then now() end, p_raw
  )
  on conflict (channel, channel_reservation_id) do update set
    guest_name     = excluded.guest_name,
    guest_phone    = coalesce(excluded.guest_phone, r.guest_phone),
    room_name      = excluded.room_name,
    check_in       = excluded.check_in,
    check_out      = excluded.check_out,
    -- 취소 메일엔 금액이 있고(결제금액) 접수 메일보다 정확할 수 있음 — null이면 기존값 보존.
    amount         = coalesce(excluded.amount, r.amount),
    options        = case when excluded.options <> '[]'::jsonb then excluded.options else r.options end,
    payment_method = excluded.payment_method,
    payment_status = excluded.payment_status,
    -- 워크플로우 상태 보존 원칙의 유일한 예외: 취소는 소스가 진실이므로 덮어쓴다.
    status         = case when p_cancelled then 'cancelled'::reservation_status else r.status end,
    cancelled_at   = case when p_cancelled and r.cancelled_at is null then now() else r.cancelled_at end,
    raw_payload    = excluded.raw_payload
  returning r.id, (r.xmax = 0) into v_id, v_is_new;

  if v_is_new then
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'detected',
              jsonb_build_object('channel', p_channel, 'payment_status', p_payment_status,
                                 'cancelled_on_arrival', p_cancelled));

    -- 취소된 예약은 방을 막을 필요가 없다 — 블록태스크 생성 생략.
    if not p_cancelled then
      insert into block_tasks (reservation_id, target_channel, check_in, check_out)
        select v_id, c, p_check_in, p_check_out
        from unnest(enum_range(null::channel)) as c
        where c <> p_channel;
    end if;
  end if;

  -- 활성→취소 전환(또는 취소 상태로 신규 도착): 이벤트 기록 + 남은 블록태스크 정리.
  if p_cancelled and (v_is_new or coalesce(v_was_cancelled, false) = false) then
    if not v_is_new then
      insert into reservation_events (reservation_id, actor, type, detail)
        values (v_id, null, 'cancelled', jsonb_build_object('source', 'channel_notification'));
    end if;

    update block_tasks
       set status = 'skipped'
     where reservation_id = v_id and status = 'pending';
  end if;

  return v_id;
end;
$$;

-- 0003과 동일한 잠금: 파싱 워커(service_role) 전용.
revoke all on function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb, boolean
) from public;
grant execute on function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb, boolean
) to service_role;
