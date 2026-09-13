import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { httpStatus, shouldRetry } from './api';

/**
 * استعلام لمسارات «approved فقط». 403 يعني أن حالة السفير تغيّرت على الخادم
 * (أُوقف مثلاً) ⇒ نعيد قراءة /me فتعرض البوابة شاشة الحالة الصحيحة بدل خطأٍ مبهم.
 */
export function useAxQuery<T>(key: readonly unknown[], fn: () => Promise<T>, onForbidden: () => void) {
  const q = useQuery({ queryKey: key, queryFn: fn, retry: shouldRetry, staleTime: 30_000 });
  const forbidden = q.isError && httpStatus(q.error) === 403;
  useEffect(() => {
    if (forbidden) onForbidden();
    // نراقب تحوّل الحالة فقط — لا تغيّر مرجع الدالّة
  }, [forbidden]);
  return q;
}
