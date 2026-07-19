-- 0010에서 게스트하우스 판별을 room_name like '객실 서쪽%'/'객실 남쪽%'로 했는데,
-- 이건 네이버가 부르는 이름이고 아임웹은 같은 방을 "서쪽방"/"남쪽방"으로 다르게 부른다
-- (실메일로 확인, 2026-07) — 아임웹 게스트하우스 예약은 이 체크에 안 걸려서 여전히
-- 스테이폴리오 막기 유령 태스크가 생겼다. 두 표기 다 인식하도록 확장.
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
  v_is_guesthouse boolean;
begin
  v_status := case
    when p_cancelled then 'cancelled'
    when p_payment_status = 'paid' then 'confirmed'
    when p_payment_status = 'pending' then 'awaiting_deposit'
    else 'new'
  end::reservation_status;

  v_is_guesthouse := p_room_name like '객실 서쪽%' or p_room_name like '객실 남쪽%'
                   or p_room_name like '서쪽방%' or p_room_name like '남쪽방%';

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
    amount         = coalesce(excluded.amount, r.amount),
    options        = case when excluded.options <> '[]'::jsonb then excluded.options else r.options end,
    payment_method = excluded.payment_method,
    payment_status = excluded.payment_status,
    status         = case when p_cancelled then 'cancelled'::reservation_status else r.status end,
    cancelled_at   = case when p_cancelled and r.cancelled_at is null then now() else r.cancelled_at end,
    raw_payload    = excluded.raw_payload
  returning r.id, (r.xmax = 0) into v_id, v_is_new;

  if v_is_new then
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'detected',
              jsonb_build_object('channel', p_channel, 'payment_status', p_payment_status,
                                 'cancelled_on_arrival', p_cancelled));

    if not p_cancelled then
      insert into block_tasks (reservation_id, target_channel, check_in, check_out)
        select v_id, c, p_check_in, p_check_out
        from unnest(enum_range(null::channel)) as c
        where c <> p_channel
          and not (v_is_guesthouse and c = 'stayfolio'::channel);
    end if;
  end if;

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

revoke all on function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb, boolean
) from public;
grant execute on function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb, boolean
) to service_role;
