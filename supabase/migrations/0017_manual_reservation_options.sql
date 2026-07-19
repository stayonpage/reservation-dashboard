-- 수동 예약 입력 폼에 옵션(추가상품) 입력란 추가 — 기존 시그니처 끝에 기본값 있는
-- 파라미터를 추가해 하위호환 유지(create or replace로 충분, drop 불필요).
create or replace function create_manual_reservation(
  p_channel        channel,
  p_room_name      text,
  p_guest_name     text,
  p_check_in       date,
  p_check_out      date,
  p_amount         integer,
  p_payment_status payment_status,
  p_options        jsonb default '[]'::jsonb
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
    p_check_in, p_check_out, p_amount, coalesce(p_options, '[]'::jsonb),
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
  channel, text, text, date, date, integer, payment_status, jsonb
) to authenticated;
