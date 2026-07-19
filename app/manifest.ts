import type { MetadataRoute } from 'next';

// 직원 4명이 각자 폰 홈 화면에 추가해 쓰는 PWA (design doc 이슈6 확정).
// 아이콘은 실제 브랜드 자산 확보 전까지 자리표시자 — public/icon-192.png, icon-512.png 추가 필요.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Reservation_Dashboard',
    short_name: 'Reservation',
    description: '스테이폴리오·네이버·아임웹 예약 통합 대시보드',
    start_url: '/',
    display: 'standalone',
    background_color: '#f7f5f2',
    theme_color: '#26221d',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
