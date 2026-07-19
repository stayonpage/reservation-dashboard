-- 버그 수정: ingest_reservation은 예약이 들어온 채널을 제외한 "나머지 모든 채널"에
-- block_tasks를 만든다. 지금까지는 방 4개(스테이 온 페이지)가 3채널 전부에 걸려있어서
-- 문제없었는데, 게스트하우스(오마이북, 객실 서쪽·남쪽 2개 유닛)는 네이버·아임웹에만
-- 있고 스테이폴리오엔 없다(운영자 확인, 2026-07) — 그런데도 스테이폴리오 예약이 들어오면
-- "스테이폴리오 막기" 태스크가 생겨버려, 직원이 볼 땐 실제로 막을 대상이 없는 유령
-- 태스크가 됐다.
--
-- 방 이름으로 게스트하우스 여부를 판별해 그 경우만 스테이폴리오 태스크 생성을 건너뛴다.
-- 새 방이 늘어나면 이 목록도 같이 늘려야 한다 — room_name 기반이라 스키마 변경 없이 가능.
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

  v_is_guesthouse := p_room_name like '객실 서쪽%' or p_room_name like '객실 남쪽%';

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
          and not (v_is_guesthouse and c = 'stayfolio'::channel); -- 게스트하우스는 스테이폴리오에 없음
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

-- 이미 잘못 생성된 게스트하우스용 스테이폴리오 막기 태스크 정리(skipped 처리, 삭제 아님 — 감사 이력 보존).
update block_tasks bt
   set status = 'skipped'
  from reservations r
 where bt.reservation_id = r.id
   and bt.target_channel = 'stayfolio'
   and bt.status = 'pending'
   and (r.room_name like '객실 서쪽%' or r.room_name like '객실 남쪽%');
