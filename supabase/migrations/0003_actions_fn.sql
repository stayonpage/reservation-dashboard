-- 대시보드 액션 함수: 방막기 체크·입금확인→확정. 인증 사용자 컨텍스트(security invoker)로 실행,
-- auth.uid()가 감사 필드(done_by/deposit_confirmed_by/confirmed_by)에 정확히 기록된다.

create or replace function toggle_block_task(p_task_id uuid, p_done boolean)
returns void
language plpgsql
security invoker
as $$
declare
  v_reservation_id uuid;
  v_target_channel channel;
  v_uid uuid := auth.uid();
begin
  update block_tasks
     set status  = case when p_done then 'done'::block_status else 'pending'::block_status end,
         done_by = case when p_done then v_uid else null end,
         done_at = case when p_done then now() else null end
   where id = p_task_id
   returning reservation_id, target_channel into v_reservation_id, v_target_channel;

  if v_reservation_id is not null then
    insert into reservation_events (reservation_id, actor, type, detail)
    values (
      v_reservation_id, v_uid,
      case when p_done then 'block_done'::event_type else 'note'::event_type end,
      jsonb_build_object('target_channel', v_target_channel, 'done', p_done)
    );
  end if;
end;
$$;

-- 잘못된 상태 전이 방지: awaiting_deposit 인 예약만 confirmed로 전이(where 절).
-- 이미 확정/취소된 예약을 다시 누르면 조용히 무시 — 충돌은 UI에서 감사 이력으로 노출.
create or replace function confirm_deposit(p_reservation_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  update reservations
     set status = 'confirmed',
         deposit_confirmed_by = v_uid,
         deposit_confirmed_at = now(),
         confirmed_by = v_uid,
         confirmed_at = now()
   where id = p_reservation_id
     and status = 'awaiting_deposit';

  if found then
    insert into reservation_events (reservation_id, actor, type, detail) values
      (p_reservation_id, v_uid, 'deposit_confirmed', '{}'::jsonb),
      (p_reservation_id, v_uid, 'confirmed', '{}'::jsonb);
  end if;
end;
$$;

grant execute on function toggle_block_task(uuid, boolean) to authenticated;
grant execute on function confirm_deposit(uuid) to authenticated;

-- 보안 강화: ingest_reservation(파싱 워커 전용, security definer)은 service_role만 호출 가능해야 한다.
-- 기본적으로 PUBLIC에 열려 있을 수 있어 명시적으로 조인다 — 일반 사용자가 임의 예약을 위조하지 못하도록.
revoke all on function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb
) from public;
grant execute on function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb
) to service_role;
