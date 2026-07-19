-- "마지막 동기화" 칩이 실제 확인 시각을 보여주도록 하트비트 테이블 추가.
--
-- 기존에는 ingest_log.received_at(마지막으로 새 메일을 처리한 시각)을 썼는데,
-- 새 메일이 없으면 기록이 안 남아 5분마다 폴링해도 칩 시간이 계속 늘어났다.
-- 폴링이 성공할 때마다(새 메일 유무와 무관하게) 소스별로 확인 시각을 남긴다.

create table if not exists sync_heartbeat (
  source text primary key,
  checked_at timestamptz not null default now()
);

alter table sync_heartbeat enable row level security;

-- 읽기는 직원 세션, 쓰기는 크론 라우트(service_role, RLS 우회)만.
create policy "authed read sync_heartbeat"
  on sync_heartbeat for select to authenticated using (true);
