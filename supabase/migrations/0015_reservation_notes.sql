-- 예약 비고(특이사항) 입력 — 직원이 자유 텍스트로 메모(예: "늦은 체크인 요청", "반려동물 문의").
-- reservations엔 이미 authenticated 전체 CRUD RLS 정책이 있어(0001) 별도 RPC 없이
-- 클라이언트에서 이 컬럼만 직접 update해도 안전하다.
alter table reservations add column notes text;
