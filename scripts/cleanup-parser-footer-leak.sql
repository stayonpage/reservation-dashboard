-- 일회성 데이터 정리 — 네이버 파서 버그(extractLabeledFields 가 값 뒤 메일 푸터를 흡수)로
-- cancel_reason / guest_request 에 <!-- 이하 잡음이 저장된 행 정정.
-- 파서 수정(fix/naver-field-footer-leak) 후, 이미 저장된 행은 재폴링해도 ingest_log 멱등에
-- 걸려 재파싱 안 되므로 여기서 직접 정리한다. 실행 전 begin, 결과 확인 후 commit.

begin;

-- 정리 대상 미리보기
select 'reservation_changes' as tbl, id, left(cancel_reason, 40) as before
  from reservation_changes where cancel_reason like '%<!--%'
union all
select 'reservations', id, left(guest_request, 40)
  from reservations where guest_request like '%<!--%';

-- 취소사유: <!-- 앞부분만, 비면 null
update reservation_changes
   set cancel_reason = nullif(btrim(split_part(cancel_reason, '<!--', 1)), '')
 where cancel_reason like '%<!--%';

-- 손님 요청: <!-- 앞부분만. '-'/'없음'/빈값 → null (파서 normalizeGuestRequest 와 동일 기준)
update reservations
   set guest_request = case
         when btrim(split_part(guest_request, '<!--', 1)) ~ '^(-+|없음)?$' then null
         else btrim(split_part(guest_request, '<!--', 1))
       end
 where guest_request like '%<!--%';

-- 정리 후 재확인 (0건이어야)
select count(*) as remaining_changes from reservation_changes where cancel_reason like '%<!--%';
select count(*) as remaining_reservations from reservations where guest_request like '%<!--%';

-- 확인 후:
-- commit;
