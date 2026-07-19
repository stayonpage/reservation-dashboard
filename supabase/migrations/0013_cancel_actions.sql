-- 직원이 직접: (1) 확정된 예약을 취소해서 방을 다시 비우거나, (2) 직접 막은 걸 취소할 수 있게.
-- 둘 다 지금까지 없었다 — 예약 취소는 자동화(스테이폴리오 ICS 재조회, service_role)만 가능했고,
-- 직접 막기는 완료(done) 체크만 있고 되돌리는 길이 없었다.

-- 1) 직접 막기 그룹 식별자. create_manual_block()이 채널 3곳에 넣는 block_tasks 3행을
--    하나의 "막기"로 묶어서 한 번에 취소할 수 있게(개별 채널만 취소하면 나머지가 유령으로 남음).
alter table block_tasks add column manual_block_group uuid;

create or replace function create_manual_block(
  p_room_code text,
  p_check_in  date,
  p_check_out date,
  p_reason    text
) returns void
language plpgsql
security invoker
as $$
declare
  v_uid   uuid := auth.uid();
  v_group uuid := gen_random_uuid();
begin
  insert into block_tasks (
    target_channel, check_in, check_out, room_code, reason, created_by, manual_block_group
  )
  select c, p_check_in, p_check_out, p_room_code, p_reason, v_uid, v_group
  from unnest(enum_range(null::channel)) as c;
end;
$$;

grant execute on function create_manual_block(text, date, date, text) to authenticated;

-- 직접 막기 취소: 그룹 전체를 skipped로 — 워크리스트/달력에서 즉시 사라지고 방이 다시 빈 것으로 보임.
create or replace function cancel_manual_block(p_group uuid)
returns void
language plpgsql
security invoker
as $$
begin
  update block_tasks
     set status = 'skipped'
   where manual_block_group = p_group
     and status <> 'skipped';
end;
$$;

grant execute on function cancel_manual_block(uuid) to authenticated;

-- 2) 직원이 직접 예약을 취소. 0007의 cancel_reservation(자동화 전용, actor=null, service_role)과
--    로직은 같지만, security invoker + auth.uid()로 누가 취소했는지 감사에 남긴다.
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
  end if;
end;
$$;

grant execute on function staff_cancel_reservation(uuid, text) to authenticated;
