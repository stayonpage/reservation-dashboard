-- 스테이폴리오가 구글 캘린더 연동을 중단하고 이메일 알림으로 전환(2026-07 확인)함에 따라
-- ingest_source enum에 신규 값 추가. 기존 stayfolio_gcal은 레거시로 남겨둔다(과거 로그 보존용).
alter type ingest_source add value if not exists 'stayfolio_email';
