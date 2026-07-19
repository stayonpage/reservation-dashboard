-- 아임웹이 예약 알림 메일을 실제로 보낸다는 사실을 2026-07 확인(사장님 네이버 계정을
-- SMTP 릴레이로 등록해 지메일로 수신). API 폴백 없이 이메일만으로 감지 가능.
alter type ingest_source add value if not exists 'imweb_email';
