-- 월간구독(아임웹 입력폼 "월간구독N개월 신청") 관리. 예약(reservations)과 로직이 달라 별도 테이블.
-- 상품: 4개월 100,000원 / 8개월 200,000원 고정(금액은 수집 시 plan_months 로 결정해 저장).
-- 통계 매출은 confirmed_at(입금확인일) 기준으로 앱에서 집계한다.

create type subscription_status as enum ('pending', 'confirmed', 'ended');

create table subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  phone              text,
  address            text,
  address_detail     text,
  plan_months        smallint not null check (plan_months in (4, 8)),
  amount             integer not null check (amount >= 0),
  status             subscription_status not null default 'pending',
  start_month        text not null check (start_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  end_month          text not null check (end_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  applied_at         timestamptz not null default now(),
  confirmed_at       timestamptz,
  ended_at           timestamptz,
  notes              text,
  source_external_id text unique,           -- 메일 Message-ID(접두어 포함) — 재수신 중복 방지
  created_at         timestamptz not null default now(),
  check (end_month >= start_month)
);
create index subscriptions_status_applied_idx on subscriptions (status, applied_at desc);

-- 달별 발송 메모(어떤 책·특산물이 나갔는지)
create table subscription_shipments (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  month           text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  memo            text not null default '',
  updated_at      timestamptz not null default now(),
  unique (subscription_id, month)
);

alter table subscriptions enable row level security;
alter table subscription_shipments enable row level security;
create policy "authed full subscriptions"
  on subscriptions for all to authenticated using (true) with check (true);
create policy "authed full subscription_shipments"
  on subscription_shipments for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table subscriptions;
alter publication supabase_realtime add table subscription_shipments;

-- 입금확인: pending 만 confirmed 로(이미 처리된 건은 조용히 무시 — confirm_deposit 와 동일 규칙).
create or replace function confirm_subscription(p_id uuid)
returns void language plpgsql security invoker as $$
begin
  update subscriptions
     set status = 'confirmed', confirmed_at = now()
   where id = p_id and status = 'pending';
end $$;

-- 입금확인 되돌리기: confirmed 만 pending 으로. confirmed_at 을 비워 통계 매출에서 빠지게 한다.
create or replace function unconfirm_subscription(p_id uuid)
returns void language plpgsql security invoker as $$
begin
  update subscriptions
     set status = 'pending', confirmed_at = null
   where id = p_id and status = 'confirmed';
end $$;

-- 종료 체크(p_ended=true: confirmed → ended) / 해제(p_ended=false: ended → confirmed).
create or replace function end_subscription(p_id uuid, p_ended boolean)
returns void language plpgsql security invoker as $$
begin
  if p_ended then
    update subscriptions set status = 'ended', ended_at = now()
     where id = p_id and status = 'confirmed';
  else
    update subscriptions set status = 'confirmed', ended_at = null
     where id = p_id and status = 'ended';
  end if;
end $$;

grant execute on function confirm_subscription(uuid) to authenticated;
grant execute on function unconfirm_subscription(uuid) to authenticated;
grant execute on function end_subscription(uuid, boolean) to authenticated;
