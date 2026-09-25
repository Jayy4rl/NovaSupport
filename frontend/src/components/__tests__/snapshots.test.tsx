import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { ProfileSkeleton } from "../profile-skeleton";
import { Skeleton } from "../skeleton";
import { Toast } from "../toast";
import { QRCodeButton } from "../qr-code-button";
import { ProfileTabs } from "../profile-tabs";
import { AppShell } from "../app-shell";

// Mock dependencies
vi.mock("framer-motion", () => {
  // Passthrough for any motion.<element>, not just the handful used today.
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const Passthrough = ({ children, ...props }: any) =>
          React.createElement(tag, props, children);
        Passthrough.displayName = `motion.${tag}`;
        return Passthrough;
      },
    },
  );
  return { motion, AnimatePresence: ({ children }: any) => children };
});

vi.mock("lucide-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("lucide-react")>()),
  History: () => <span>HistoryIcon</span>,
  Award: () => <span>AwardIcon</span>,
  LayoutDashboard: () => <span>DashboardIcon</span>,
  ExternalLink: () => <span>ExternalLinkIcon</span>,
  CheckCircle2: () => <span>CheckIcon</span>,
  AlertCircle: () => <span>AlertIcon</span>,
  X: () => <span>XIcon</span>,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  API_BASE_URL: "http://localhost:4000",
  SITE_URL: "https://novasupport.app",
}));

vi.mock("@/lib/stellar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar")>()),
  getNetworkLabel: vi.fn(() => "Testnet"),
}));

vi.mock("@/components/wallet-connect", () => ({
  WalletConnect: () => <div data-testid="wallet-connect">WalletConnect</div>,
}));

vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => <button data-testid="theme-toggle">Toggle</button>,
}));

vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

describe("Component Snapshots", () => {
  it("ProfileSkeleton matches snapshot", () => {
    const { container } = render(<ProfileSkeleton />);
    expect(container).toMatchSnapshot();
  });

  it("Skeleton matches snapshot", () => {
    const { container } = render(<Skeleton className="h-4 w-full" />);
    expect(container).toMatchSnapshot();
  });

  it("Toast matches snapshot (success)", () => {
    const { container } = render(<Toast message="Success!" type="success" onDismiss={() => {}} />);
    expect(container).toMatchSnapshot();
  });

  it("Toast matches snapshot (error)", () => {
    const { container } = render(<Toast message="Error!" type="error" onDismiss={() => {}} />);
    expect(container).toMatchSnapshot();
  });

  it("QRCodeButton matches snapshot", () => {
    const { container } = render(<QRCodeButton username="testuser" />);
    expect(container).toMatchSnapshot();
  });

  it("ProfileTabs matches snapshot", () => {
    const { container } = render(<ProfileTabs username="testuser" />);
    expect(container).toMatchSnapshot();
  });

  it("AppShell matches snapshot", () => {
    const { container } = render(
      <AppShell>
        <div data-testid="child-content">Page content</div>
      </AppShell>,
    );
    expect(container).toMatchSnapshot();
  });
});
