import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { deliverWebhook, shouldRetry, getNextRetryDelay } from "./webhook.js";
import { Metrics } from "../metrics.js";
import { getIsRedisAvailable } from "./redis.js";
import {
  createWebhookQueue,
  createWebhookWorker,
  enqueueWebhookDelivery,
  stopWebhookQueue,
  getWebhookQueue,
} from "./webhook-queue.js";

const MAX_DELIVERY_ATTEMPTS = 3;

export async function processPendingWebhookDeliveries(
  prismaClient = prisma,
  deliver = deliverWebhook,
) {
  const now = new Date();

  const pendingDeliveries = await prismaClient.webhookDelivery.findMany({
    where: {
      status: "pending",
      nextRetryAt: { lte: now },
      attemptCount: { lt: MAX_DELIVERY_ATTEMPTS },
    },
    include: {
      webhook: true,
    },
    take: 50,
  });

  for (const delivery of pendingDeliveries) {
    const claimed = await prismaClient.webhookDelivery.updateMany({
      where: { id: delivery.id, status: "pending" },
      data: { status: "processing" },
    });
    if (claimed.count === 0) continue;

    const payload = delivery.payload as Record<string, unknown>;
    const result = await deliver(delivery.webhook.url, delivery.webhook.signingKey, payload);

    if (result.status === "success") {
      await prismaClient.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "success",
          attemptCount: delivery.attemptCount + 1,
          lastError: null,
        },
      });
      logger.info(
        { deliveryId: delivery.id, webhookId: delivery.webhookId, statusCode: result.statusCode },
        "Webhook delivered successfully",
      );
      Metrics.webhooksDelivered();
    } else {
      const nextAttempt = delivery.attemptCount + 1;
      const willRetry = result.willRetry && shouldRetry(nextAttempt);

      let nextRetryAt: Date | null = null;
      if (willRetry) {
        const delayMs = getNextRetryDelay(delivery.attemptCount);
        if (delayMs !== null) {
          nextRetryAt = new Date(Date.now() + delayMs);
        }
      }

      await prismaClient.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: willRetry ? "pending" : "failed",
          attemptCount: nextAttempt,
          nextRetryAt,
          lastError: result.error,
        },
      });

      logger.warn(
        {
          deliveryId: delivery.id,
          webhookId: delivery.webhookId,
          attempt: nextAttempt,
          nextRetryAt,
          error: result.error,
        },
        willRetry ? "Webhook delivery failed, scheduled retry" : "Webhook delivery failed permanently"
      );
      if (willRetry) {
        Metrics.webhookRetries();
      }
      Metrics.webhookDeliveryErrors();
    }
  }
}

export type WebhookProcessorHandle = {
  stop(): Promise<void>;
};

let processorInterval: ReturnType<typeof setInterval> | null = null;
let processorInFlight: Promise<void> | null = null;
let processorStopped = true;

type ProcessorOptions = {
  redisAvailable?: boolean;
  intervalMs?: number;
  processPending?: typeof processPendingWebhookDeliveries;
  startQueue?: typeof createWebhookQueue;
  startWorker?: typeof createWebhookWorker;
};

export function startWebhookProcessor(options: ProcessorOptions = {}): WebhookProcessorHandle {
  const redisAvailable = options.redisAvailable ?? getIsRedisAvailable();
  const processPending = options.processPending ?? processPendingWebhookDeliveries;
  const interval = options.intervalMs ?? Number(process.env.WEBHOOK_PROCESSOR_INTERVAL_MS ?? 10000);

  if (redisAvailable) {
    logger.info("Redis available — starting BullMQ webhook queue");
    (options.startQueue ?? createWebhookQueue)();
    (options.startWorker ?? createWebhookWorker)();
  }

  // SQL-scheduled retries must still be swept when Redis is available, so
  // BullMQ and the poller share the same atomic status claim.
  logger.info({ interval, redisAvailable }, "Starting DB-polled webhook processor");
  processorStopped = false;
  processorInterval = setInterval(() => {
    if (!processorInFlight) {
      processorInFlight = processPending()
        .catch((err) => {
          logger.error({ err }, "Error in webhook processor run");
        })
        .finally(() => {
          processorInFlight = null;
        });
    }
  }, interval);

  return {
    async stop() {
      if (processorStopped) return;
      processorStopped = true;
      if (processorInterval) {
        clearInterval(processorInterval);
        processorInterval = null;
      }
      if (processorInFlight) {
        await processorInFlight;
      }
      if (redisAvailable) {
        await stopWebhookQueue();
      }
      logger.info("Webhook processor stopped.");
    },
  };
}
