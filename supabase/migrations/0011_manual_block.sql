-- 예약 없이 직접 방을 막는 기능(청소·보수·개인사용 등). 새 테이블 없이 block_tasks를
-- 확장한다 — 어차피 realtime·체크박스(toggle_block_task)·화면 렌더가 이미 block_tasks
-- 기준으로 다 되어 있어서, room_code/reason만 얹으면 그대로 재사용 가능하다.
--
-- reservation_id를 nullable로 바꾸고, "예약 기반 아니면 room_code+reason 필수"를 체크 제약으로 강제.

alter table block_tasks alter column reservation_id drop not null;
alter table block_tasks add column room_code text;
alter table block_tasks add column reason text;
alter table block_tasks add column created_by uuid references profiles(id);

alter table block_tasks add constraint block_tasks_manual_or_reservation check (
  (reservation_id is not null)
  or (room_code is not null and reason is not null)
);

-- 지원 화면(인증 사용자)에서 직접 호출 — 사유 입력 후 채널 3곳 전부에 "막기" 태스크를 만든다.
-- 예약 기반과 달리 "온 채널을 제외한 나머지"가 아니라 전 채널이 대상(직접 막는 건 어느 채널에서
-- 시작된 게 아니므로).
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
  v_uid uuid := auth.uid();
begin
  insert into block_tasks (target_channel, check_in, check_out, room_code, reason, created_by)
  select c, p_check_in, p_check_out, p_room_code, p_reason, v_uid
  from unnest(enum_range(null::channel)) as c;
end;
$$;

grant execute on function create_manual_block(text, date, date, text) to authenticated;
