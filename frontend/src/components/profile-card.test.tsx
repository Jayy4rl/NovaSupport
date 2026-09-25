import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileCard } from '@/components/profile-card';

const showToast = vi.fn();

// Mock @/lib/config
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  API_BASE_URL: 'http://localhost:4000',
  STELLAR_NETWORK: 'TESTNET',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  CONTRACT_ID: '',
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
}));

// Mock @/lib/stellar
vi.mock('@/lib/stellar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stellar')>()),
  getNetworkLabel: vi.fn(() => 'Testnet'),
  isValidStellarAddress: vi.fn(() => true),
  stellarConfig: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    stellarNetwork: 'TESTNET',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
}));

vi.mock('@/lib/use-toast', () => ({
  useToast: () => ({ showToast }),
}));

describe('ProfileCard', () => {
  beforeEach(() => {
    showToast.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  const mockProfile = {
    username: 'stellar-dev',
    displayName: 'Stellar Developer',
    bio: 'Building on Stellar blockchain',
    walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    acceptedAssets: [
      { code: 'XLM', issuer: null },
      { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDMSCR4XFM6KJLGMGR5E2Q3ZXZQ4KQQYT5R3332W' },
    ],
    email: 'dev@example.com',
    websiteUrl: 'https://example.com',
    twitterHandle: 'stellardev',
    githubHandle: 'stellar-dev',
  };

  it('renders display name and username', () => {
    const { container } = render(<ProfileCard {...mockProfile} />);
    
    expect(screen.getByText('@stellar-dev')).toBeInTheDocument();
    expect(screen.getByText('Stellar Developer')).toBeInTheDocument();
    expect(container).toMatchSnapshot();
  });

  it('renders bio', () => {
    const { container } = render(<ProfileCard {...mockProfile} />);
    
    expect(screen.getByText('Building on Stellar blockchain')).toBeInTheDocument();
    expect(container).toMatchSnapshot();
  });

  it('renders wallet address', () => {
    render(<ProfileCard {...mockProfile} />);
    
    expect(screen.getByText('Stellar Wallet')).toBeInTheDocument();
    expect(screen.getByText(mockProfile.walletAddress)).toBeInTheDocument();
  });

  it('renders social links', () => {
    render(<ProfileCard {...mockProfile} />);
    
    expect(screen.getByText('🌐 Website')).toBeInTheDocument();
    expect(screen.getByText('𝕏 @stellardev')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
  });

  it('renders accepted assets', () => {
    render(<ProfileCard {...mockProfile} />);
    
    expect(screen.getByText('Accepted assets')).toBeInTheDocument();
    expect(screen.getByText('XLM')).toBeInTheDocument();
    expect(screen.getByText('USDC')).toBeInTheDocument();
  });

  it('renders skeleton when isLoading is true', () => {
    const { container } = render(<ProfileCard {...mockProfile} isLoading={true} />);
    
    // The skeleton article is rendered
    expect(container.querySelector('article')).toBeInTheDocument();
    // The display name should NOT be rendered
    expect(screen.queryByText('Stellar Developer')).not.toBeInTheDocument();
    expect(container).toMatchSnapshot();
  });

  it('shows success toast after copying wallet address', async () => {
    render(<ProfileCard {...mockProfile} />);
    fireEvent.click(
      screen.getByRole('button', { name: /copy wallet address to clipboard/i }),
    );

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Wallet address copied!', 'success');
    });
  });

  it('supports Ctrl/Cmd+C while wallet address is focused', async () => {
    render(<ProfileCard {...mockProfile} />);
    const walletLink = screen.getByLabelText(
      new RegExp(`Stellar wallet address: ${mockProfile.walletAddress}`, 'i'),
    );
    walletLink.focus();
    fireEvent.keyDown(walletLink, { key: 'c', ctrlKey: true });

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Wallet address copied!', 'success');
    });
  });
});
