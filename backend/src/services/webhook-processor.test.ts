import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { processPendingWebhookDeliveries, startWebhookProcessor } from "./webhook-processor.js";

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "delivery-1",
    webhookId: "webhook-1",
    payload: { event: "support.created" },
    status: "pending",
    attemptCount: 0,
    nextRetryAt: new Date(),
    webhook: { url: "https://example.com/hook", secret: "s3cret" },
    ...overrides,
  };
}

function buildPrismaMock(overrides: {
  deliveries?: unknown[];
  claimCount?: number;
} = {}) {
  const findMany = mock.fn(() => Promise.resolve(overrides.deliveries ?? [makeDelivery()]));
  const updateMany = mock.fn(() => Promise.resolve({ count: overrides.claimCount ?? 1 }));
  const update = mock.fn(() => Promise.resolve({}));

  return {
    prismaClient: {
      webhookDelivery: { findMany, update, updateMany },
    },
    findMany,
    updateMany,
    update,
  };
}

function getUpdateData(update: ReturnType<typeof mock.fn>, callIndex = 0): Record<string, unknown> {
  return (update.mock.calls[callIndex]!.arguments[0] as { data: Record<string, unknown> }).data;
}

test("successful delivery updates the record to success and increments attemptCount", async () => {
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery({ attemptCount: 0 })],
  });
  const deliver = mock.fn(() => Promise.resolve({ status: "success", statusCode: 200 }));

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  assert.equal(update.mock.calls.length, 1);
  const data = getUpdateData(update);
  assert.equal(data.status, "success");
  assert.equal(data.attemptCount, 1);
  assert.equal(data.lastError, null);
});

test("HTTP 500 keeps status pending and sets nextRetryAt to the backoff schedule", async () => {
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery({ attemptCount: 0 })],
  });
  const deliver = mock.fn(() =>
    Promise.resolve({ status: "failed", error: "HTTP 500", willRetry: true }),
  );

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  const data = getUpdateData(update);
  assert.equal(data.status, "pending");
  assert.equal(data.attemptCount, 1);
  assert.ok(data.nextRetryAt instanceof Date);
  assert.ok((data.nextRetryAt as Date).getTime() > Date.now());
});

test("Redis mode still polls SQL so due webhook retries are delivered", async () => {
  let queueStarted = false;
  let workerStarted = false;
  let pollCount = 0;
  const handle = startWebhookProcessor({
    redisAvailable: true,
    intervalMs: 2,
    startQueue: () => {
      queueStarted = true;
      return null;
    },
    startWorker: () => {
      workerStarted = true;
      return null;
    },
    processPending: async () => {
      pollCount += 1;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  await handle.stop();

  assert.equal(queueStarted, true);
  assert.equal(workerStarted, true);
  assert.ok(pollCount > 0, "the SQL retry sweep should run while Redis is active");
});

test("HTTP 4xx permanent failure sets status failed with no further retry scheduled", async () => {
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery({ attemptCount: 0 })],
  });
  const deliver = mock.fn(() =>
    Promise.resolve({ status: "failed", error: "HTTP 404", willRetry: false }),
  );

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  const data = getUpdateData(update);
  assert.equal(data.status, "failed");
  assert.equal(data.nextRetryAt, null);
});

test("reaching max attempts sets status to failed", async () => {
  // attemptCount is already at MAX_DELIVERY_ATTEMPTS - 1 (2); the query itself
  // filters attemptCount < MAX_DELIVERY_ATTEMPTS (3), so this is the last try.
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery({ attemptCount: 2 })],
  });
  const deliver = mock.fn(() =>
    Promise.resolve({ status: "failed", error: "HTTP 500", willRetry: true }),
  );

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  const data = getUpdateData(update);
  // nextAttempt = 3, shouldRetry(3) is expected to be false at the max attempt.
  assert.equal(data.status, "failed");
  assert.equal(data.attemptCount, 3);
});

test("a network timeout is treated as a transient failure and scheduled for retry", async () => {
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery({ attemptCount: 0 })],
  });
  const deliver = mock.fn(() =>
    Promise.resolve({ status: "failed", error: "The operation was aborted due to timeout", willRetry: true }),
  );

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  const data = getUpdateData(update);
  assert.equal(data.status, "pending");
  assert.ok(data.nextRetryAt instanceof Date);
});

test("a row already claimed by a concurrent run is skipped (no delivery attempted)", async () => {
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery()],
    claimCount: 0,
  });
  const deliver = mock.fn(() => Promise.resolve({ status: "success", statusCode: 200 }));

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  assert.equal(deliver.mock.calls.length, 0);
  assert.equal(update.mock.calls.length, 0);
});
