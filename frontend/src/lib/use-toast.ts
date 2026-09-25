import { useState, useCallback, useRef } from 'react';

type Toast = { message: string; type: 'success' | 'error' };

export function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type });
    timerRef.current = setTimeout(() => setToast(null), 5000);
  }, []);

  return { toast, showToast, dismiss: () => setToast(null) };
}
