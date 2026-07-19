import { describe, it, expect } from 'vitest';
import { roomCodeOf } from './rooms';

describe('roomCodeOf', () => {
  it('page 계열 설명 문구가 붙어도 코드만 뽑는다', () => {
    expect(roomCodeOf('page26 - 시가 내려앉는 순간')).toBe('page26');
    expect(roomCodeOf('page 8 - 숨결같은 선율에 머무는 하루')).toBe('page8');
  });

  it('page1이 page127로 오매칭되지 않는다', () => {
    expect(roomCodeOf('page127 - 별서에서 흐르는 시간')).toBe('page127');
    expect(roomCodeOf('page1234')).toBeNull();
  });

  it('게스트하우스 방 이름을 정확히 매칭한다(네이버 표기)', () => {
    expect(roomCodeOf('객실 서쪽')).toBe('객실 서쪽');
    expect(roomCodeOf('객실 남쪽')).toBe('객실 남쪽');
  });

  it('채널마다 다른 표기(아임웹 "서쪽방"/"남쪽방")도 같은 코드로 매칭한다', () => {
    expect(roomCodeOf('서쪽방')).toBe('객실 서쪽');
    expect(roomCodeOf('남쪽방')).toBe('객실 남쪽');
  });

  it('매칭 안 되는 방/null은 null', () => {
    expect(roomCodeOf('알 수 없는 방')).toBeNull();
    expect(roomCodeOf(null)).toBeNull();
  });
});
