-- 월간구독자가 숙박 할인 혜택을 받았는지 여부(구독자당 체크 하나). 기존 행은 모두 false.
-- 롤백: alter table subscriptions drop column stay_discount_used;
alter table subscriptions
  add column stay_discount_used boolean not null default false;
