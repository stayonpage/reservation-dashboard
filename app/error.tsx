'use client';

import { useEffect } from 'react';

// 대시보드 라우트 에러 바운더리. page.tsx 가 예약·막기·동기화·큐 4개 쿼리를 병렬로
// 부르는데, 동시 접속으로 인한 일시적 timeout/커넥션 실패 등 하나만 던져도 지금까진
// Next 기본 크래시 화면이 떴다. 이제 재시도 버튼 + 자동 1회 재시도로 degrade 한다.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[dashboard] render error', error.digest, error.message);
    // 일시적 원인(대개 DB timeout)일 가능성이 커서 한 번은 자동 재시도.
    const t = setTimeout(() => reset(), 1500);
    return () => clearTimeout(t);
  }, [error, reset]);

  return (
    <main>
      <div className="header">
        <h1>Reservation_Dashboard</h1>
      </div>
      <div className="empty" style={{ textAlign: 'left', padding: 20 }}>
        <strong>일시적으로 대시보드를 불러오지 못했습니다.</strong>
        <p style={{ marginTop: 8, fontSize: 13 }}>
          잠시 후 자동으로 다시 시도합니다. 계속 안 되면 아래 버튼을 눌러주세요.
        </p>
        <button
          type="button"
          className="deeplink"
          style={{ cursor: 'pointer', marginTop: 12 }}
          onClick={() => reset()}
        >
          다시 시도
        </button>
        {error.digest && (
          <p style={{ marginTop: 12, fontSize: 11, opacity: 0.6 }}>
            오류 코드: {error.digest}
          </p>
        )}
      </div>
    </main>
  );
}
