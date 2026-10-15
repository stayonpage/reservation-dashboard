-- 0029 롤백(주의: 구독 데이터가 모두 사라진다).
drop function if exists end_subscription(uuid, boolean);
drop function if exists unconfirm_subscription(uuid);
drop function if exists confirm_subscription(uuid);
alter publication supabase_realtime drop table subscription_shipments;
alter publication supabase_realtime drop table subscriptions;
drop table if exists subscription_shipments;
drop table if exists subscriptions;
drop type if exists subscription_status;
