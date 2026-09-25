const DEFAULTS: Record<string, string> = {
  NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
  NEXT_PUBLIC_API_BASE_URL: "http://localhost:4001",
};

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    if (DEFAULTS[key]) {
      console.warn(`Missing environment variable: ${key}. Using default value.`);
      return DEFAULTS[key];
    }
    throw new Error(
      `Missing required environment variable: ${key}. Check frontend/.env.example.`
    );
  }
  return value;
}

export const HORIZON_URL = requireEnv("NEXT_PUBLIC_HORIZON_URL");
export const API_BASE_URL = requireEnv("NEXT_PUBLIC_API_BASE_URL");

export const STELLAR_NETWORK =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "TESTNET";

export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Optional Soroban / contract configuration
export const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
export const SOROBAN_RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
