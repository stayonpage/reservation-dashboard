-- 0023 롤백 (비상용). Supabase SQL Editor 에 붙여넣고 Run.
--
-- ⚠️ 전제:
--   1) 이 롤백은 "0023 적용 직후, confirm_reservation_change / confirm_cancel_review /
--      confirm_uncancel_review 를 아직 아무도 안 눌렀을 때" 안전하다. 눌렀다면 한 채널에
--      block_tasks 가 2줄 생겼을 수 있어 아래 unique 제약 재추가가 실패한다 →
--      그 경우 중복 block_tasks 를 먼저 정리하거나, 제약 재추가 줄만 빼고 실행.
--   2) 새 앱(feat/reservation-change-review)이 이미 배포됐다면 함께 이전 커밋으로 revert 해야 한다
--      (새 앱은 ingest_reservation 14-arg 를 호출 → 13-arg 로 되돌리면 새 앱이 깨진다).
--   3) 실행 전 begin, 확인 후 commit. 문제 있으면 rollback.

begin;

-- ── 1) v2 RPC 제거 ──
drop function if exists confirm_reservation_change(uuid);
drop function if exists keep_reservation_change(uuid);
drop function if exists confirm_cancel_review(uuid);
drop function if exists confirm_uncancel_review(uuid);
drop function if exists enqueue_ics_cancel_review(uuid);

-- ── 2) ingest_reservation: 0023 의 14-arg 제거 + 0014 의 13-arg 복원 ──
drop function if exists ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb, boolean, text);

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

    update block_tasks
       set status = 'pending', action = 'unblock'
     where reservation_id = v_id and status = 'done';
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

-- ── 3) block_tasks unique 제약 복원 (confirm_* 안 눌렀을 때만 성공) ──
drop index if exists block_tasks_res_channel_idx;
alter table block_tasks
  add constraint block_tasks_reservation_id_target_channel_key unique (reservation_id, target_channel);

-- ── 4) 컬럼 / 테이블 제거 ──
alter table reservations drop column if exists prev_check_in;
alter table reservations drop column if exists prev_check_out;
alter table reservations drop column if exists guest_request;
drop table if exists reservation_changes;   -- 트리거·정책·인덱스·realtime publication 등록 동반 제거

-- 확인 후:
-- commit;
-- 문제 있으면:
-- rollback;
