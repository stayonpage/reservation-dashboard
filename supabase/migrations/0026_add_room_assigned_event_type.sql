-- "오늘의 페이지" 랜덤객실을 실제 객실로 배정할 때 남기는 감사 이벤트 타입.
-- alter type ... add value는 같은 트랜잭션 내에서 바로 못 써서(Postgres 제약) 별도 파일로 분리
-- (0027에서 이 값을 쓰는 assign_random_room 함수를 정의).
alter type event_type add value if not exists 'room_assigned';
