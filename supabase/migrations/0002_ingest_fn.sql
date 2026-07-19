-- 예약 수신 함수: (채널+예약번호) upsert + 신규면 감지이벤트/블록태스크 자동 생성.
--
-- 핵심 안전장치: ON CONFLICT 시 소스 파생 필드만 갱신하고
--   status / *_by / *_at(감사·워크플로우) 는 절대 건드리지 않는다.
--   → 같은 메일/문자를 재수신해도 이미 '확정'한 예약이 'new'로 리셋되지 않음.

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
  p_raw                    jsonb
) returns uuid
language plpgsql
security definer
as $$
declare
  v_id     uuid;
  v_is_new boolean;
  v_status reservation_status;
begin
  -- 선결제(카드 등 결제완료)면 바로 confirmed, 아니면 new(지원이 트리아지).
  v_status := case
    when p_payment_status = 'paid' then 'confirmed'
    else 'new'
  end::reservation_status;

  insert into reservations as r (
    channel, channel_reservation_id, guest_name, guest_phone, room_name,
    check_in, check_out, amount, options,
    payment_method, payment_status, status, raw_payload
  ) values (
    p_channel, p_channel_reservation_id, p_guest_name, p_guest_phone, p_room_name,
    p_check_in, p_check_out, p_amount, coalesce(p_options, '[]'::jsonb),
    p_payment_method, p_payment_status, v_status, p_raw
  )
  on conflict (channel, channel_reservation_id) do update set
    -- 소스 파생 필드만 갱신. status/감사 필드는 의도적으로 제외.
    guest_name     = excluded.guest_name,
    guest_phone    = coalesce(excluded.guest_phone, r.guest_phone), -- 뒤에 온 값이 비어도 기존 유지
    room_name      = excluded.room_name,
    check_in       = excluded.check_in,
    check_out      = excluded.check_out,
    amount         = excluded.amount,
    options        = excluded.options,
    payment_method = excluded.payment_method,
    payment_status = excluded.payment_status,
    raw_payload    = excluded.raw_payload
  returning r.id, (r.xmax = 0) into v_id, v_is_new; -- xmax=0 → 이번에 INSERT된 신규 행

  -- 신규 예약일 때만: 감지 이벤트 + 나머지 채널 "막아라" 태스크.
  if v_is_new then
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'detected',
              jsonb_build_object('channel', p_channel, 'payment_status', p_payment_status));

    insert into block_tasks (reservation_id, target_channel, check_in, check_out)
      select v_id, c, p_check_in, p_check_out
      from unnest(enum_range(null::channel)) as c
      where c <> p_channel; -- 예약이 들어온 채널 제외한 나머지
  end if;

  return v_id;
end;
$$;
