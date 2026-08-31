-- security definer 함수에 명시적 search_path 고정 (Supabase 린터 function_search_path_mutable).
--
-- 미룬 Minor #2 (v2 opus 리뷰). definer 함수는 호출자의 search_path 를 물려받으므로,
-- 악의적 세션이 search_path 를 조작해 public 대신 자기 스키마의 동명 객체를 호출하게 만들 수 있다.
-- ALTER FUNCTION ... SET 은 함수 본문을 건드리지 않고 이름 해석만 public 으로 고정한다(무동작 변경).
--
-- 값은 이미 고정돼 있던 handle_new_user(0004) 와 동일하게 'public'. 본문이 테이블명을
-- 비수식(reservations, block_tasks 등)으로 참조하므로 ''(빈 값) 은 못 쓴다. 내장 함수는
-- pg_catalog 가 항상 암묵적으로 먼저 검색되므로 now()/coalesce 등은 그대로 해석된다.
--
-- 이미 고정돼 있어 여기서 제외: handle_new_user(0004, =public), invoke_pollers/set_polling_secret(0019, ='').

alter function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb, boolean, text
) set search_path = public;

alter function enqueue_ics_cancel_review(uuid) set search_path = public;

alter function cancel_reservation(uuid, text) set search_path = public;

alter function confirm_deposit(uuid) set search_path = public;
