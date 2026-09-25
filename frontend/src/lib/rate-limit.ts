export type RateLimitInfo = {
  resetAt: Date | null;
  limit: number | null;
  remaining: number | null;
};

function parseNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseRateLimitInfo(headers: Headers): RateLimitInfo {
  const limit = parseNumber(headers.get("ratelimit-limit"));
  const remaining = parseNumber(headers.get("ratelimit-remaining"));

  let resetAt: Date | null = null;

  const retryAfterRaw = headers.get("retry-after");
  const retryAfterSeconds = parseNumber(retryAfterRaw);
  if (typeof retryAfterSeconds === "number") {
    resetAt = new Date(Date.now() + retryAfterSeconds * 1000);
  } else if (retryAfterRaw) {
    const retryAfterDate = Date.parse(retryAfterRaw);
    resetAt = Number.isNaN(retryAfterDate) ? null : new Date(retryAfterDate);
  }

  if (!resetAt) {
    const resetValue = parseNumber(headers.get("ratelimit-reset"));
    if (typeof resetValue === "number") {
      const ms = resetValue > 1e12 ? resetValue : resetValue * 1000;
      resetAt = new Date(ms);
    }
  }

  return { resetAt, limit, remaining };
}

export function formatRateLimitedMessage(info: RateLimitInfo): string {
  if (!info.resetAt || Number.isNaN(info.resetAt.getTime())) {
    return "Rate limited. Please try again shortly.";
  }

  const time = info.resetAt.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Rate limited until ${time}. Please try again later.`;
}

