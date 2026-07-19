-- 숙박통합사이트 v1 — Supabase(Postgres) 초기 스키마
-- 설계 근거: ~/.gstack/projects/_/byeolli-unknown-design-20260709-082103-sukbak-integration.md
-- 확정 사항 반영: (채널+예약번호) upsert 멱등성 / 감사(누가·언제) / 4인 동일 풀권한 /
--                실시간 동기화 / 무음유실·파싱실패 가시화 / 입금확인→확정 워크플로우.

-- =====================================================================
-- ENUMs
-- =====================================================================
create type channel            as enum ('imweb', 'naver', 'stayfolio');
create type payment_method     as enum ('card', 'cash', 'unknown');
create type payment_status     as enum ('paid', 'pending', 'none');        -- 채널이 알려준 결제 사실
create type reservation_status as enum ('new', 'awaiting_deposit', 'confirmed', 'cancelled'); -- 지원이 다루는 워크플로우 상태
create type block_status       as enum ('pending', 'done', 'skipped');
create type event_type         as enum ('detected','updated','deposit_confirmed','confirmed','cancelled','block_done','note');
create type ingest_source      as enum ('naver_email','stayfolio_sms','stayfolio_gcal','imweb_webhook','imweb_api');

-- =====================================================================
-- profiles — auth.users 위에 표시이름(감사 "누가")
-- =====================================================================
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- =====================================================================
-- reservations — 3채널 정규화 단일 진실원
-- =====================================================================
create table reservations (
  id                    uuid primary key default gen_random_uuid(),
  channel               channel not null,
  channel_reservation_id text   not null,                 -- 소스 예약번호 (네이버 1287059074, 스테이 775617172 …)

  guest_name            text,
  guest_phone           text,                             -- nullable: 네이버는 마스킹/부재, 스테이·아임웹은 있음
  room_name             text,                             -- 예약객실/상품명 (v1은 자유텍스트 — 방 매핑은 아래 NOTE 참조)
  check_in              date not null,
  check_out             date not null,
  amount                integer,                          -- 총액(원, 정수)
  options               jsonb not null default '[]'::jsonb, -- [{"name":"조식_멋진하루","qty":2,"price":12000}]

  payment_method        payment_method not null default 'unknown',
  payment_status        payment_status not null default 'pending',
  status                reservation_status not null default 'new',

  -- 감사(현재상태 빠른조회용 — 이력은 reservation_events)
  deposit_confirmed_by  uuid references profiles(id),
  deposit_confirmed_at  timestamptz,
  confirmed_by          uuid references profiles(id),
  confirmed_at          timestamptz,
  cancelled_by          uuid references profiles(id),
  cancelled_at          timestamptz,

  raw_payload           jsonb,                            -- 원본(문자/메일/API) 보존 → 재파싱·감사
  detected_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- ★ 멱등성/중복방지: 같은 예약이 여러 번 수신돼도 1행 (upsert on conflict)
  unique (channel, channel_reservation_id)
);
create index reservations_status_idx   on reservations (status);
create index reservations_checkin_idx  on reservations (check_in);
create index reservations_channel_idx  on reservations (channel);

-- =====================================================================
-- reservation_events — append-only 감사/이력 (충돌 가시화 "이미 지원이 확정함")
-- =====================================================================
create table reservation_events (
  id             bigint generated always as identity primary key,
  reservation_id uuid not null references reservations(id) on delete cascade,
  actor          uuid references profiles(id),            -- null = 시스템(자동 감지)
  type           event_type not null,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index reservation_events_res_idx on reservation_events (reservation_id, created_at desc);

-- =====================================================================
-- block_tasks — 오버부킹 워크리스트("다른 채널 막아라") + 완료추적(깜빡 누락 0)
--   예약 감지 시 나머지 채널(들)에 대해 pending 태스크 생성. 지원이 막고 done 체크.
-- =====================================================================
create table block_tasks (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references reservations(id) on delete cascade,
  target_channel channel not null,                        -- 막아야 할 채널
  check_in       date not null,
  check_out      date not null,
  status         block_status not null default 'pending',
  done_by        uuid references profiles(id),
  done_at        timestamptz,
  created_at     timestamptz not null default now(),
  unique (reservation_id, target_channel)
);
create index block_tasks_status_idx on block_tasks (status);

-- =====================================================================
-- ingest_log — 원시 수신 로그: 멱등성 + 파싱실패 가시화 + "마지막 동기화 시각"
--   실패모드 대응: 무음 유실(IMAP 끊김)·파싱 실패를 눈에 보이게, 재수신 무시.
-- =====================================================================
create table ingest_log (
  id                    bigint generated always as identity primary key,
  source                ingest_source not null,
  external_id           text,                             -- 메일 UID / SMS id / webhook id
  raw                   text,                             -- 원문
  parsed_reservation_id uuid references reservations(id),
  status                text not null default 'received', -- received | parsed | parse_failed | duplicate
  error                 text,
  received_at           timestamptz not null default now(),
  unique (source, external_id)                            -- 같은 원시 메시지 재수신 무시
);
create index ingest_log_source_time_idx on ingest_log (source, received_at desc);

-- =====================================================================
-- updated_at 자동 갱신
-- =====================================================================
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger reservations_set_updated_at
  before update on reservations
  for each row execute function set_updated_at();

-- =====================================================================
-- RLS — 인증된 4인은 역할 구분 없이 전부 접근 (개별 로그인은 감사 목적)
-- =====================================================================
alter table profiles           enable row level security;
alter table reservations       enable row level security;
alter table reservation_events enable row level security;
alter table block_tasks        enable row level security;
alter table ingest_log         enable row level security;

create policy "authed read profiles"   on profiles for select to authenticated using (true);
create policy "authed upsert own profile" on profiles for insert to authenticated with check (auth.uid() = id);
create policy "authed update own profile" on profiles for update to authenticated using (auth.uid() = id);

create policy "authed full reservations"        on reservations       for all to authenticated using (true) with check (true);
create policy "authed full reservation_events"  on reservation_events for all to authenticated using (true) with check (true);
create policy "authed full block_tasks"         on block_tasks        for all to authenticated using (true) with check (true);
create policy "authed full ingest_log"          on ingest_log         for all to authenticated using (true) with check (true);
-- 주: 파싱 워커는 service_role 키로 접속(RLS 우회)해 ingest_log/reservations upsert.

-- =====================================================================
-- Realtime — 4대 폰에 즉시 반영
-- =====================================================================
alter publication supabase_realtime add table reservations;
alter publication supabase_realtime add table block_tasks;
alter publication supabase_realtime add table reservation_events;

-- =====================================================================
-- NOTE (v1 결정 / v2 과제)
--  1) room_name 자유텍스트: 채널마다 방 이름/ID가 다를 수 있음. v1은 자유텍스트로 두고
--     워크리스트에 "page452 7/10~7/11 아임웹에서 막아라"로 표시 → 사람이 매핑.
--     채널별 방ID를 잇는 canonical `rooms` 매핑 테이블은 v2.
--  2) block_tasks는 채널 단위(+예약의 room_name 참조). 방 단위 정밀화는 v2.
--  3) 자동 방막기 없음(아임웹 API·iCal 부재 확정) — block_tasks는 "수동+딥링크" 워크리스트.
-- =====================================================================
