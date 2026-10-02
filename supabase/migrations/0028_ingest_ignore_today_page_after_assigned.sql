-- "오늘의 페이지" 랜덤객실 배정 후 재수신 메일이 가짜 변경요청을 큐에 넣는 문제 수정.
-- (2026-10-02 전체 리뷰 Important #5)
--
-- 아임웹은 메일 본문에 항상 원래 상품명("오늘의 페이지")을 그대로 담아 보낸다 — 우리가
-- 내부적으로 room_name을 실제 객실(예: 'page26')로 바꿔놔도 아임웹 쪽은 그걸 모른다.
-- 그래서 같은 주문의 메일이 한 번이라도 더 처리되면(입금확인 메일, gmail 재동기화 등)
-- p_room_name='오늘의 페이지' vs 기존 room_name='page26'이 달라 보여서 v_changed가
-- true가 되고, "변경 확인" 큐에 가짜 건이 쌓인다. 직원이 실수로 "변경 확정"을 누르면
-- room_name이 '오늘의 페이지'로 되돌아가 버린다(assign_random_room 이전 상태로 리그레션).
--
-- 수정: 이미 배정된(= room_name이 '오늘의 페이지'가 아닌) 예약에 '오늘의 페이지' 그대로
-- 들어오면, 그 값은 "의미 없는 원래 상품명"으로 취급해 기존 room_name으로 치환한다
-- (v_effective_room_name). 변경 감지·레코드 저장 전부 이 값을 쓴다 — 그래서 room 비교는
-- 항상 "같음"이 되고, 다른 필드(날짜 등)만 바뀐 경우에도 new_room_name이 '오늘의 페이지'로
-- 잘못 저장되는 일이 없다.
--
-- 영향 범위: '오늘의 페이지'로 들어오는 예약(이 기능 전용)에만 적용. 다른 모든 채널/상품의
-- 동작은 기존과 동일(v_effective_room_name = p_room_name 그대로).
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
  p_cancelled              boolean default false,
  p_guest_request          text default null
) returns uuid
language plpgsql
security definer
as $$
declare
  v_id            uuid;
  v_exists        boolean;
  v_existing      reservations%rowtype;
  v_status        reservation_status;
  v_is_guesthouse boolean;
  v_opts          jsonb := coalesce(p_options, '[]'::jsonb);
  v_changed       boolean;   -- 날짜/객실/옵션 중 하나라도
  v_cancel_reason text := nullif(btrim(coalesce(p_raw->'fields'->>'취소사유','')), '');
  v_pending_kind  text;
  v_eff_room_name text;      -- '오늘의 페이지' 재수신 시 기존 배정값으로 치환(위 설명 참고)
begin
  v_status := case
    when p_payment_status = 'paid' then 'confirmed'
    when p_payment_status = 'pending' then 'awaiting_deposit'
    else 'new'
  end::reservation_status;

  v_is_guesthouse := coalesce(
    p_room_name like '객실 서쪽%' or p_room_name like '객실 남쪽%'
    or p_room_name like '서쪽방%' or p_room_name like '남쪽방%', false);

  select * into v_existing
    from reservations
   where channel = p_channel and channel_reservation_id = p_channel_reservation_id;
  v_exists := found;

  -- ── A) 신규 예약 ── (v1 그대로 + guest_request)
  if not v_exists then
    insert into reservations (
      channel, channel_reservation_id, guest_name, guest_phone, room_name,
      check_in, check_out, amount, options, payment_method, payment_status, status,
      cancelled_at, raw_payload, guest_request
    ) values (
      p_channel, p_channel_reservation_id, p_guest_name, p_guest_phone, p_room_name,
      p_check_in, p_check_out, p_amount, v_opts, p_payment_method, p_payment_status,
      case when p_cancelled then 'cancelled' else v_status end::reservation_status,
      case when p_cancelled then now() end, p_raw, p_guest_request
    ) returning id into v_id;

    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'detected',
              jsonb_build_object('channel', p_channel, 'payment_status', p_payment_status,
                                 'cancelled_on_arrival', p_cancelled));
    if not p_cancelled then
      insert into block_tasks (reservation_id, target_channel, check_in, check_out)
        select v_id, c, p_check_in, p_check_out
        from unnest(enum_range(null::channel)) as c
        where c <> p_channel and not (v_is_guesthouse and c = 'stayfolio'::channel);
    end if;
    return v_id;
  end if;

  v_id := v_existing.id;

  -- '오늘의 페이지' 재수신 + 이미 실제 객실로 배정됨 → 아임웹이 보내는 원래 상품명은
  -- 무시하고 기존 배정값을 그대로 유지(위 파일 상단 설명).
  v_eff_room_name := case
    when p_room_name = '오늘의 페이지' and v_existing.room_name is distinct from '오늘의 페이지'
      then v_existing.room_name
    else p_room_name
  end;

  -- 원문·결제·요청사항은 어느 경로든 항상 최신화(큐 트리거 아님).
  update reservations
     set raw_payload    = p_raw,
         payment_method = p_payment_method,
         payment_status = p_payment_status,
         -- 요청사항 없는 재수신(취소통지·ICS재동기화 등)이 기존 값을 지우지 않도록 coalesce
         guest_request  = coalesce(p_guest_request, guest_request)
   where id = v_id;

  select kind into v_pending_kind
    from reservation_changes where reservation_id = v_id and status = 'pending';

  -- ── B) 이미 취소된 예약 재수신 ──
  if v_existing.status = 'cancelled' then
    if p_cancelled then
      return v_id;                       -- 멱등
    end if;
    -- 정상 접수 메일 = 되살리기 신호 → uncancel 큐
    insert into reservation_changes (
      reservation_id, kind,
      prev_check_in, prev_check_out, prev_room_name, prev_amount, prev_guest_name, prev_options,
      new_guest_name, new_guest_phone, new_room_name, new_check_in, new_check_out,
      new_amount, new_options, new_payment_method, new_payment_status, new_raw_payload
    ) values (
      v_id, 'uncancel',
      v_existing.check_in, v_existing.check_out, v_existing.room_name,
      v_existing.amount, v_existing.guest_name, coalesce(v_existing.options,'[]'::jsonb),
      p_guest_name, p_guest_phone, v_eff_room_name, p_check_in, p_check_out,
      p_amount, v_opts, p_payment_method, p_payment_status, p_raw
    )
    on conflict (reservation_id) where status = 'pending'
    do update set kind='uncancel',
      new_check_in=excluded.new_check_in, new_check_out=excluded.new_check_out,
      new_room_name=excluded.new_room_name, new_amount=excluded.new_amount,
      new_options=excluded.new_options, new_guest_name=excluded.new_guest_name,
      new_guest_phone=excluded.new_guest_phone, new_payment_method=excluded.new_payment_method,
      new_payment_status=excluded.new_payment_status, new_raw_payload=excluded.new_raw_payload;
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'note', jsonb_build_object('source','uncancel_review_queued'));
    return v_id;
  end if;

  -- ── C) 활성 예약 재수신 ──
  if p_cancelled then
    -- 취소 신호 → cancel 큐 (예약 status 는 안 바꿈). 취소가 변경보다 우선.
    insert into reservation_changes (
      reservation_id, kind, cancel_reason, cancel_source,
      prev_check_in, prev_check_out, prev_room_name, prev_amount, prev_guest_name, prev_options,
      new_guest_name, new_guest_phone, new_room_name, new_check_in, new_check_out,
      new_amount, new_options, new_payment_method, new_payment_status, new_raw_payload
    ) values (
      v_id, 'cancel', v_cancel_reason, 'channel_notification',
      v_existing.check_in, v_existing.check_out, v_existing.room_name,
      v_existing.amount, v_existing.guest_name, coalesce(v_existing.options,'[]'::jsonb),
      p_guest_name, p_guest_phone, v_eff_room_name, p_check_in, p_check_out,
      p_amount, v_opts, p_payment_method, p_payment_status, p_raw
    )
    on conflict (reservation_id) where status = 'pending'
    do update set kind='cancel', cancel_reason=coalesce(excluded.cancel_reason, reservation_changes.cancel_reason),
      cancel_source='channel_notification',
      new_raw_payload=excluded.new_raw_payload;
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'note', jsonb_build_object('source','cancel_review_queued','reason', v_cancel_reason));
    return v_id;
  end if;

  v_changed :=
       p_check_in  is distinct from v_existing.check_in
    or p_check_out is distinct from v_existing.check_out
    or (v_eff_room_name is not null and v_eff_room_name is distinct from v_existing.room_name)
    or (v_opts <> '[]'::jsonb and v_opts is distinct from coalesce(v_existing.options,'[]'::jsonb));

  if v_changed then
    if v_pending_kind = 'cancel' then
      -- 취소 검토가 우선 — 변경분은 큐에 안 넣고 흔적만.
      insert into reservation_events (reservation_id, actor, type, detail)
        values (v_id, null, 'note', jsonb_build_object('source','change_ignored_cancel_pending'));
      return v_id;
    end if;
    insert into reservation_changes (
      reservation_id, kind,
      prev_check_in, prev_check_out, prev_room_name, prev_amount, prev_guest_name, prev_options,
      new_guest_name, new_guest_phone, new_room_name, new_check_in, new_check_out,
      new_amount, new_options, new_payment_method, new_payment_status, new_raw_payload
    ) values (
      v_id, 'change',
      v_existing.check_in, v_existing.check_out, v_existing.room_name,
      v_existing.amount, v_existing.guest_name, coalesce(v_existing.options,'[]'::jsonb),
      p_guest_name, p_guest_phone, v_eff_room_name, p_check_in, p_check_out,
      p_amount, v_opts, p_payment_method, p_payment_status, p_raw
    )
    on conflict (reservation_id) where status = 'pending'
    do update set
      new_check_in=excluded.new_check_in, new_check_out=excluded.new_check_out,
      new_room_name=excluded.new_room_name, new_amount=excluded.new_amount,
      new_options=excluded.new_options, new_guest_name=excluded.new_guest_name,
      new_guest_phone=excluded.new_guest_phone, new_payment_method=excluded.new_payment_method,
      new_payment_status=excluded.new_payment_status, new_raw_payload=excluded.new_raw_payload;
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'updated', jsonb_build_object('source','channel_notification',
        'from', jsonb_build_object('check_in',v_existing.check_in,'check_out',v_existing.check_out,'room_name',v_existing.room_name),
        'to',   jsonb_build_object('check_in',p_check_in,'check_out',p_check_out,'room_name',v_eff_room_name)));
    return v_id;
  end if;

  -- 값 동일(날짜/객실/옵션): guest/amount 는 위에서 이미 raw/pay 만 갱신했으니 여기서 본체도 맞춤
  update reservations set
    guest_name = p_guest_name,
    guest_phone = coalesce(p_guest_phone, guest_phone),
    amount = coalesce(p_amount, amount)
  where id = v_id
    and (guest_name is distinct from p_guest_name
      or (p_guest_phone is not null and guest_phone is distinct from p_guest_phone)
      or (p_amount is not null and amount is distinct from p_amount));
  if found then
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'updated', jsonb_build_object('source','channel_notification','fields','guest_or_amount'));
    -- 금액 정정이 대기 중 확인 건의 위약금 기준(prev_amount)에도 반영되도록
    update reservation_changes
       set prev_amount = coalesce(p_amount, prev_amount)
     where reservation_id = v_id and status = 'pending';
  end if;

  -- 대기 건 자동 철회
  if v_pending_kind = 'change' then
    update reservation_changes set status='withdrawn', resolved_at=now()
     where reservation_id = v_id and status='pending';
    if found then
      insert into reservation_events (reservation_id, actor, type, detail)
        values (v_id, null, 'note', jsonb_build_object('note','손님이 원래 예약 내용으로 되돌림 — 변경 요청 자동 철회'));
    end if;
  elsif v_pending_kind = 'cancel' then
    update reservation_changes set status='withdrawn', resolved_at=now()
     where reservation_id = v_id and status='pending';
    if found then
      insert into reservation_events (reservation_id, actor, type, detail)
        values (v_id, null, 'note', jsonb_build_object('note','정상 접수 메일 재수신 — 취소 요청 자동 철회(손님이 취소 철회)'));
    end if;
  end if;

  return v_id;
end;
$$;

-- CREATE OR REPLACE는 시그니처가 같으면 기존 권한을 유지하지만, search_path 고정(0025)은
-- 안전하게 다시 명시한다.
alter function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb, boolean, text
) set search_path = public;
