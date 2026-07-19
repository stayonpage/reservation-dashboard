-- 취소 메일 도착 시 처리 보강: 지금까지는 아직 안 막은(pending) 채널만 할 일에서 지워줬고,
-- 이미 막아놓은(done) 채널은 아무 처리도 안 해서 방이 계속 막힌 채로 방치됐다(수익 손실 위험) —
-- 운영자 피드백(2026-07): "이미 막아놓은 채널은 다시 열어야 하는데 그걸 알려줘야 한다."
--
-- block_tasks에 action('block'/'unblock')을 추가 — done 상태였던 태스크는 취소 시
-- pending+unblock으로 되돌려서 워크리스트에 "다시 열기"로 다시 뜨게 한다.
create type block_action as enum ('block', 'unblock');
alter table block_tasks add column action block_action not null default 'block';

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

    -- 아직 안 막은 채널: 이제 막을 필요 없음 — 할 일에서 제거.
    update block_tasks
       set status = 'skipped'
     where reservation_id = v_id and status = 'pending';

    -- 이미 막아놓은 채널: 다시 열어야 함 — "다시 열기" 할 일로 전환(무음 유실 방지).
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

-- 같은 보강을 취소가 일어나는 나머지 두 경로에도 적용:
--  1) cancel_reservation — 스테이폴리오 ICS 재조회가 "예약번호가 사라짐"을 감지해 자동 취소.
--  2) staff_cancel_reservation — 대시보드 달력 토글로 직원이 직접 취소.
create or replace function cancel_reservation(p_id uuid, p_reason text default 'unknown')
returns void
language plpgsql
security definer
as $$
begin
  update reservations
     set status = 'cancelled',
         cancelled_at = coalesce(cancelled_at, now())
   where id = p_id
     and status <> 'cancelled';

  if found then
    insert into reservation_events (reservation_id, actor, type, detail)
      values (p_id, null, 'cancelled', jsonb_build_object('reason', p_reason));

    update block_tasks
       set status = 'skipped'
     where reservation_id = p_id
       and status = 'pending';

    update block_tasks
       set status = 'pending', action = 'unblock'
     where reservation_id = p_id
       and status = 'done';
  end if;
end;
$$;

revoke all on function cancel_reservation(uuid, text) from public;
grant execute on function cancel_reservation(uuid, text) to service_role;

create or replace function staff_cancel_reservation(p_reservation_id uuid, p_reason text default '직원 취소')
returns void
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  update reservations
     set status = 'cancelled',
         cancelled_by = v_uid,
         cancelled_at = coalesce(cancelled_at, now())
   where id = p_reservation_id
     and status <> 'cancelled';

  if found then
    insert into reservation_events (reservation_id, actor, type, detail)
      values (p_reservation_id, v_uid, 'cancelled',
              jsonb_build_object('reason', p_reason, 'source', 'staff_manual'));

    update block_tasks
       set status = 'skipped'
     where reservation_id = p_reservation_id and status = 'pending';

    update block_tasks
       set status = 'pending', action = 'unblock'
     where reservation_id = p_reservation_id and status = 'done';
  end if;
end;
$$;

grant execute on function staff_cancel_reservation(uuid, text) to authenticated;
