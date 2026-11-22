'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Notifications moved into Settings; keep old links working. */
export default function NotificationsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/settings?tab=notifications');
  }, [router]);
  return null;
}
