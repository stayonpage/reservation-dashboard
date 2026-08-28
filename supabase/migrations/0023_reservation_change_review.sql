-- 예약 변경 확인 워크플로우.
--
-- ⚠️ 배포 순서: 이 마이그레이션을 앱 배포보다 "먼저" 적용해야 한다. app/page.tsx 가
--    getPendingReservationChanges()를 초기 로드에 포함하므로, reservation_changes 테이블이
--    없는 상태로 새 앱이 뜨면 대시보드 전체가 500. 적용 후 확인:
--      select conname from pg_constraint where conrelid='block_tasks'::regclass;
--    → block_tasks_reservation_id_target_channel_key 가 "없어야" 하고
--      block_tasks_manual_or_reservation 는 "남아 있어야" 한다.
--
-- 지금까지: 같은 예약번호로 변경 메일이 오면 ingest_reservation이 check_in/out 등을 즉시
-- 덮어썼다 → 원래 날짜·이력 유실, 새 날짜 막기 태스크 미생성.
--
-- 이제: 변경분을 reservation_changes(pending 큐)에 적재하고 예약 본체는 그대로 둔다.
-- 직원이 대시보드에서 [기존 예약 유지] 또는 [변경 확정]을 누를 때 반영한다.
-- 손님이 원래 값으로 되돌리면(들어온 값 == 현재 예약) pending 큐 건을 자동 철회(withdrawn).

-- ── 1) 변경 대기 큐 ────────────────────────────────────────────────
create table reservation_changes (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references reservations(id) on delete cascade,

  -- 확정 "직전" 스냅샷(option B). 재변경 시 최초값이 아니라 그때의 현재값으로 갱신됨은 아니고,
  -- pending 1건이 유지되는 동안 prev_*는 최초 진입 시점(=확정 전 예약 상태)으로 고정된다.
  prev_check_in   date    not null,
  prev_check_out  date    not null,
  prev_room_name  text,
  prev_amount     integer,
  prev_guest_name text,
  prev_options    jsonb   not null default '[]'::jsonb,

  -- 들어온 새 값(파서 출력 그대로)
  new_guest_name     text,
  new_guest_phone    text,
  new_room_name      text,
  new_check_in       date not null,
  new_check_out      date not null,
  new_amount         integer,
  new_options        jsonb not null default '[]'::jsonb,
  new_payment_method payment_method not null,
  new_payment_status payment_status not null,
  new_raw_payload    jsonb,

  status      text not null default 'pending'
              check (status in ('pending','confirmed','kept','withdrawn')),
  resolved_by uuid references profiles(id),
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 한 예약에 열려있는(pending) 변경은 항상 1건 — upsert 대상.
create unique index reservation_changes_one_pending
  on reservation_changes (reservation_id) where status = 'pending';
create index reservation_changes_status_idx
  on reservation_changes (status, new_check_in);

create trigger reservation_changes_set_updated_at
  before update on reservation_changes
  for each row execute function set_updated_at();

alter table reservation_changes enable row level security;
create policy "authed full reservation_changes"
  on reservation_changes for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table reservation_changes;

-- ── 2) reservations: 확정된 변경의 직전 날짜 보관(카드 "이전 …에서 변경") ──
alter table reservations add column prev_check_in  date;
alter table reservations add column prev_check_out date;

-- ── 3) block_tasks: (reservation_id, target_channel) unique 제거 ──
-- 변경 확정 시 한 채널에 "옛 날짜 다시 열기"와 "새 날짜 막기"가 동시에 필요.
-- 이 쌍에 대한 ON CONFLICT 사용처는 코드베이스에 없음(확인함) → 조회용 일반 인덱스로 대체.
alter table block_tasks drop constraint if exists block_tasks_reservation_id_target_channel_key;
create index block_tasks_res_channel_idx on block_tasks (reservation_id, target_channel);

-- ── 4) ingest_reservation: 변경 감지 분기 ─────────────────────────
-- 베이스는 0014_unblock_on_cancel.sql 의 정의. ON CONFLICT 한 방 upsert 대신
-- "기존 행 조회 → 분기"로 재구성한다(변경분은 예약을 안 건드리고 큐로 보내야 하므로).
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
  v_exists        boolean;
  v_was_cancelled boolean;
  v_status        reservation_status;
  v_is_guesthouse boolean;
  v_existing      reservations%rowtype;
  v_changed       boolean;
  v_opts          jsonb := coalesce(p_options, '[]'::jsonb);
  v_withdrawn     boolean;
begin
  v_status := case
    when p_cancelled then 'cancelled'
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
  v_was_cancelled := v_exists and v_existing.status = 'cancelled';

  -- ── A) 신규 예약 ──
  if not v_exists then
    insert into reservations (
      channel, channel_reservation_id, guest_name, guest_phone, room_name,
      check_in, check_out, amount, options,
      payment_method, payment_status, status,
      cancelled_at, raw_payload
    ) values (
      p_channel, p_channel_reservation_id, p_guest_name, p_guest_phone, p_room_name,
      p_check_in, p_check_out, p_amount, v_opts,
      p_payment_method, p_payment_status, v_status,
      case when p_cancelled then now() end, p_raw
    )
    returning id into v_id;

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

    return v_id;
  end if;

  v_id := v_existing.id;

  -- ── B) 취소 메일 ──
  if p_cancelled then
    update reservations set
      guest_name     = p_guest_name,
      guest_phone    = coalesce(p_guest_phone, guest_phone),
      room_name      = p_room_name,
      check_in       = p_check_in,
      check_out      = p_check_out,
      amount         = coalesce(p_amount, amount),
      options        = case when v_opts <> '[]'::jsonb then v_opts else options end,
      payment_method = p_payment_method,
      payment_status = p_payment_status,
      status         = 'cancelled',
      cancelled_at   = coalesce(cancelled_at, now()),
      raw_payload    = p_raw
    where id = v_id;

    if not coalesce(v_was_cancelled, false) then
      insert into reservation_events (reservation_id, actor, type, detail)
        values (v_id, null, 'cancelled', jsonb_build_object('source', 'channel_notification'));

      update block_tasks set status = 'skipped'
       where reservation_id = v_id and status = 'pending';
      update block_tasks set status = 'pending', action = 'unblock'
       where reservation_id = v_id and status = 'done';
    end if;

    -- 취소가 우선 — 열려있던 변경 대기는 철회.
    update reservation_changes
       set status = 'withdrawn', resolved_at = now()
     where reservation_id = v_id and status = 'pending';

    return v_id;
  end if;

  -- ── C) 활성 예약 재수신 ──
  -- 취소된 예약은 변경 큐로 보내지 않는다(디자인 §5.4). 원문·결제 필드만 최신화.
  if v_existing.status = 'cancelled' then
    update reservations
       set raw_payload    = p_raw,
           payment_method = p_payment_method,
           payment_status = p_payment_status
     where id = v_id;
    return v_id;
  end if;

  v_changed :=
       p_check_in   is distinct from v_existing.check_in
    or p_check_out  is distinct from v_existing.check_out
    or (p_room_name is not null and p_room_name is distinct from v_existing.room_name)
    or p_guest_name is distinct from v_existing.guest_name
    or (p_amount is not null      and p_amount      is distinct from v_existing.amount)
    or (p_guest_phone is not null and p_guest_phone is distinct from v_existing.guest_phone)
    or (v_opts <> '[]'::jsonb     and v_opts        is distinct from coalesce(v_existing.options, '[]'::jsonb));

  -- 원문은 어느 쪽이든 최신으로 보존(재파싱·감사).
  -- 결제수단·결제상태는 0014 처럼 활성 재수신마다 재동기화한다(예: 입금대기→입금완료).
  -- 날짜/객실/이름/금액/옵션 변경만 검토 큐(reservation_changes)로 라우팅하고, 결제 필드는 즉시 반영.
  update reservations
     set raw_payload    = p_raw,
         payment_method = p_payment_method,
         payment_status = p_payment_status
   where id = v_id;

  if v_changed then
    insert into reservation_changes (
      reservation_id,
      prev_check_in, prev_check_out, prev_room_name, prev_amount, prev_guest_name, prev_options,
      new_guest_name, new_guest_phone, new_room_name, new_check_in, new_check_out,
      new_amount, new_options, new_payment_method, new_payment_status, new_raw_payload
    ) values (
      v_id,
      v_existing.check_in, v_existing.check_out, v_existing.room_name,
      v_existing.amount, v_existing.guest_name, coalesce(v_existing.options, '[]'::jsonb),
      p_guest_name, p_guest_phone, p_room_name, p_check_in, p_check_out,
      p_amount, v_opts, p_payment_method, p_payment_status, p_raw
    )
    on conflict (reservation_id) where status = 'pending'
    do update set
      new_guest_name     = excluded.new_guest_name,
      new_guest_phone    = excluded.new_guest_phone,
      new_room_name      = excluded.new_room_name,
      new_check_in       = excluded.new_check_in,
      new_check_out      = excluded.new_check_out,
      new_amount         = excluded.new_amount,
      new_options        = excluded.new_options,
      new_payment_method = excluded.new_payment_method,
      new_payment_status = excluded.new_payment_status,
      new_raw_payload    = excluded.new_raw_payload;

    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'updated',
              jsonb_build_object(
                'source', 'channel_notification',
                'from', jsonb_build_object('check_in', v_existing.check_in, 'check_out', v_existing.check_out,
                                           'room_name', v_existing.room_name, 'amount', v_existing.amount),
                'to',   jsonb_build_object('check_in', p_check_in, 'check_out', p_check_out,
                                           'room_name', p_room_name, 'amount', p_amount)));
  else
    -- 값 동일: 손님이 원래대로 되돌린 경우 대기 건 자동 철회.
    update reservation_changes
       set status = 'withdrawn', resolved_at = now()
     where reservation_id = v_id and status = 'pending';
    v_withdrawn := found;

    if v_withdrawn then
      insert into reservation_events (reservation_id, actor, type, detail)
        values (v_id, null, 'note',
                jsonb_build_object('note', '손님이 원래 예약 내용으로 되돌림 — 변경 요청 자동 철회'));
    end if;
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

-- ── 5) [기존 예약 유지] ──────────────────────────────────────────
create or replace function keep_reservation_change(p_change_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_uid  uuid := auth.uid();
  v_res  uuid;
  v_from jsonb;
  v_to   jsonb;
begin
  update reservation_changes
     set status = 'kept', resolved_by = v_uid, resolved_at = now()
   where id = p_change_id and status = 'pending'
   returning reservation_id,
             jsonb_build_object('check_in', prev_check_in, 'check_out', prev_check_out,
                                'room_name', prev_room_name, 'amount', prev_amount),
             jsonb_build_object('check_in', new_check_in, 'check_out', new_check_out,
                                'room_name', new_room_name, 'amount', new_amount)
      into v_res, v_from, v_to;

  if v_res is not null then
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_res, v_uid, 'note',
              jsonb_build_object('note', '예약 변경 요청 거절 — 기존 예약 유지',
                                 'from', v_from, 'to', v_to));
  end if;
end;
$$;
grant execute on function keep_reservation_change(uuid) to authenticated;

-- ── 6) [변경 확정] ──────────────────────────────────────────────
create or replace function confirm_reservation_change(p_change_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_uid           uuid := auth.uid();
  c               reservation_changes%rowtype;
  r               reservations%rowtype;
  v_new_status    reservation_status;
  v_is_guesthouse boolean;
begin
  select * into c from reservation_changes where id = p_change_id and status = 'pending';
  if not found then return; end if;

  select * into r from reservations where id = c.reservation_id;
  -- 취소된 예약(Fix 1 배포 전 큐잉됐을 수 있음)은 되살리지 않는다.
  if not found or r.status = 'cancelled' then return; end if;

  -- 원자적 클레임: pending 행을 confirmed 로 낚아챈다. 두 직원이 동시에(또는 더블클릭으로)
  -- 눌러도 이 update 는 한 번만 성공하고, 진 쪽은 여기서 빠져나간다 — 6b/6c/6d 중복 실행
  -- (중복 막기 태스크·이벤트, done→unblock 이중 적용) 방지. keep_reservation_change 와 동일.
  update reservation_changes
     set status = 'confirmed', resolved_by = v_uid, resolved_at = now()
   where id = p_change_id and status = 'pending';
  if not found then return; end if;

  v_new_status := case
    when c.new_payment_status = 'paid'    then 'confirmed'
    when c.new_payment_status = 'pending' then 'awaiting_deposit'
    else 'new'
  end::reservation_status;

  v_is_guesthouse := coalesce(
    c.new_room_name like '객실 서쪽%' or c.new_room_name like '객실 남쪽%'
    or c.new_room_name like '서쪽방%' or c.new_room_name like '남쪽방%', false);

  -- 6a) 예약 본체 in-place 갱신(id 유지). notes(직원 메모)는 건드리지 않음.
  update reservations set
    guest_name     = coalesce(c.new_guest_name, guest_name),
    guest_phone    = coalesce(c.new_guest_phone, guest_phone),
    room_name      = coalesce(c.new_room_name, room_name),
    check_in       = c.new_check_in,
    check_out      = c.new_check_out,
    amount         = coalesce(c.new_amount, amount),
    options        = case when c.new_options <> '[]'::jsonb then c.new_options else options end,
    payment_method = c.new_payment_method,
    payment_status = c.new_payment_status,
    status         = v_new_status,
    prev_check_in  = c.prev_check_in,
    prev_check_out = c.prev_check_out,
    deposit_confirmed_by = null,
    deposit_confirmed_at = null,
    confirmed_by   = null,
    confirmed_at   = null,
    cancelled_by   = null,
    cancelled_at   = null,
    raw_payload    = coalesce(c.new_raw_payload, raw_payload)
  where id = c.reservation_id;

  -- 6b) 옛 날짜 정리: 아직 안 막은 건 제거, 이미 막은 건 "다시 열기"로.
  update block_tasks set status = 'skipped'
   where reservation_id = c.reservation_id and status = 'pending' and action = 'block';
  update block_tasks set status = 'pending', action = 'unblock'
   where reservation_id = c.reservation_id and status = 'done' and action = 'block';

  -- 6c) 새 날짜 "막아라" 태스크(다른 채널). block_tasks unique 제거됨(0023 §3)이라 공존 가능.
  insert into block_tasks (reservation_id, target_channel, check_in, check_out, action, status)
    select c.reservation_id, ch2, c.new_check_in, c.new_check_out, 'block', 'pending'
    from unnest(enum_range(null::channel)) as ch2
    where ch2 <> r.channel
      and not (v_is_guesthouse and ch2 = 'stayfolio'::channel);

  -- 6d) 이벤트
  insert into reservation_events (reservation_id, actor, type, detail) values
    (c.reservation_id, v_uid, 'detected',
     jsonb_build_object('source', 'reservation_change',
        'from', jsonb_build_object('check_in', c.prev_check_in, 'check_out', c.prev_check_out),
        'to',   jsonb_build_object('check_in', c.new_check_in,  'check_out', c.new_check_out))),
    (c.reservation_id, v_uid, 'note', jsonb_build_object('note', '예약 변경 확정'));

  -- 큐 행은 함수 진입 시 이미 confirmed 로 클레임됨(위 원자적 update).
end;
$$;
grant execute on function confirm_reservation_change(uuid) to authenticated;
