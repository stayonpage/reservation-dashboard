-- 스테이폴리오 ICS 대사(reconciliation) 전용 취소 함수.
-- toggle_block_task/confirm_deposit(0003)은 "직원이 로그인해서 누른" 행동이라 auth.uid()로
-- 감사를 남기지만, 이건 자동화된 백엔드 작업(service_role)이 "ICS에서 사라짐"을 감지해
-- 대신 취소하는 것이라 actor=null(시스템)로 남긴다 — ingest_reservation의 감지 이벤트와 동일 패턴.
--
-- 이미 취소된 건은 조용히 무시(where status <> 'cancelled')해 중복 이벤트를 남기지 않는다.

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
  end if;
end;
$$;

-- 자동화 백엔드(service_role) 전용 — 일반 직원 계정이 임의로 예약을 취소하지 못하도록 잠근다.
revoke all on function cancel_reservation(uuid, text) from public;
grant execute on function cancel_reservation(uuid, text) to service_role;
