-- 시스템 도입 전에 이미 들어와 있던 예약을 직원이 수동으로 입력 — 자동 감지된 예약과
-- 동일하게 취급되도록(통계·매출 집계, 다른 채널 막기 할 일 자동 생성, 달력 점유 표시).
-- "직접 막기"(0011)와는 다르다 — 그건 방/사유만 있는 가짜 예약이라 통계에 안 잡히지만,
-- 이건 진짜 reservations 행을 만들어서 이메일로 들어온 것과 똑같이 흐른다.
--
-- channel_reservation_id가 없으므로(원본 메일이 없음) 합성 키를 만든다 — 스테이폴리오
-- 이메일 파서의 합성키 패턴(guest_email|check_in|...)과 같은 이유·같은 해법.
create or replace function create_manual_reservation(
  p_channel        channel,
  p_room_name      text,
  p_guest_name     text,
  p_check_in       date,
  p_check_out      date,
  p_amount         integer,
  p_payment_status payment_status
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_uid           uuid := auth.uid();
  v_id            uuid;
  v_status        reservation_status;
  v_synthetic_id  text;
  v_is_guesthouse boolean;
begin
  v_status := case
    when p_payment_status = 'paid' then 'confirmed'
    when p_payment_status = 'pending' then 'awaiting_deposit'
    else 'new'
  end::reservation_status;

  v_is_guesthouse := p_room_name like '객실 서쪽%' or p_room_name like '객실 남쪽%'
                   or p_room_name like '서쪽방%' or p_room_name like '남쪽방%';

  v_synthetic_id := 'manual-' || extract(epoch from now())::bigint || '-'
                   || substr(gen_random_uuid()::text, 1, 8);

  insert into reservations (
    channel, channel_reservation_id, guest_name, room_name,
    check_in, check_out, amount, options,
    payment_method, payment_status, status, raw_payload
  ) values (
    p_channel, v_synthetic_id, p_guest_name, p_room_name,
    p_check_in, p_check_out, p_amount, '[]'::jsonb,
    'unknown', p_payment_status, v_status,
    jsonb_build_object('source', 'manual_entry', 'created_by', v_uid)
  )
  returning id into v_id;

  insert into reservation_events (reservation_id, actor, type, detail)
    values (v_id, v_uid, 'detected', jsonb_build_object('source', 'manual_entry'));

  insert into block_tasks (reservation_id, target_channel, check_in, check_out)
    select v_id, c, p_check_in, p_check_out
    from unnest(enum_range(null::channel)) as c
    where c <> p_channel
      and not (v_is_guesthouse and c = 'stayfolio'::channel);

  return v_id;
end;
$$;

grant execute on function create_manual_reservation(
  channel, text, text, date, date, integer, payment_status
) to authenticated;
