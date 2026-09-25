import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ProfileTabs } from '@/components/profile-tabs';

// Mock framer-motion to avoid animation issues in tests
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

type Pending = {
  url: string;
  signal?: AbortSignal;
  resolve: (body: unknown) => void;
};

/**
 * fetch double that never settles on its own, so a test can decide the exact
 * order in which two in-flight requests come back. It honours `signal` the way
 * the real fetch does: an aborted request rejects with an AbortError.
 */
function createDeferredFetch() {
  const pending: Pending[] = [];

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    return new Promise((resolve, reject) => {
      const entry: Pending = {
        url,
        signal: init?.signal ?? undefined,
        resolve: (body: unknown) => resolve({ ok: true, json: async () => body }),
      };
      pending.push(entry);

      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    });
  });

  return { fetchMock, pending };
}

const tx = (id: string, amount: string) => ({
  id,
  txHash: id.repeat(64).slice(0, 64),
  amount,
  assetCode: 'XLM',
  createdAt: '2026-03-01T00:00:00Z',
  status: 'SUCCESS',
});

describe('ProfileTabs transaction search — out-of-order responses', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Types into the search box and lets the 300ms debounce elapse. */
  async function search(term: string) {
    fireEvent.change(screen.getByPlaceholderText('Search by message…'), {
      target: { value: term },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
  }

  it('passes an abort signal on every transaction search request', async () => {
    const { fetchMock, pending } = createDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<ProfileTabs username="alice" />);

    await act(async () => {
      pending[0].resolve({ transactions: [] });
    });

    await search('coffee');

    const searchRequest = pending.find(p => p.url.includes('q=coffee'));
    expect(searchRequest).toBeDefined();
    expect(searchRequest!.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the previous request when the search term changes', async () => {
    const { fetchMock, pending } = createDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<ProfileTabs username="alice" />);

    await act(async () => {
      pending[0].resolve({ transactions: [] });
    });

    await search('a');
    const first = pending.find(p => p.url.includes('q=a&') || p.url.endsWith('q=a'))!;
    expect(first.signal!.aborted).toBe(false);

    await search('ab');
    expect(first.signal!.aborted).toBe(true);
  });

  it('does not let a stale response overwrite newer results', async () => {
    const { fetchMock, pending } = createDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<ProfileTabs username="alice" />);

    await act(async () => {
      pending[0].resolve({ transactions: [] });
    });

    // First keystroke settles the debounce and fires request #1.
    await search('a');
    const stale = pending[pending.length - 1];

    // Second keystroke fires request #2 and aborts request #1.
    await search('ab');
    const fresh = pending[pending.length - 1];

    // The newer request answers first with the correct results...
    await act(async () => {
      fresh.resolve({ transactions: [tx('1', '100')] });
    });
    expect(await screen.findByText('100 XLM')).toBeInTheDocument();

    // ...and the older, superseded request answers afterwards. Its payload must
    // be discarded rather than clobbering the newer results.
    await act(async () => {
      stale.resolve({ transactions: [tx('2', '999')] });
    });

    expect(screen.getByText('100 XLM')).toBeInTheDocument();
    expect(screen.queryByText('999 XLM')).not.toBeInTheDocument();
  });
});
