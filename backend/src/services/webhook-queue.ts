import { Queue, Worker } from "bullmq";
import { getRedisClient, getIsRedisAvailable } from "./redis.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { deliverWebhook, shouldRetry, getNextRetryDelay } from "./webhook.js";
import { Metrics } from "../metrics.js";

const QUEUE_NAME = "webhook-delivery";
const MAX_DELIVERY_ATTEMPTS = 3;

let queue: Queue | null = null;
let worker: Worker | null = null;

export interface WebhookJobData {
  deliveryId: string;
  webhookId: string;
  url: string;
  signingKey: string;
  payload: Record<string, unknown>;
}

export function createWebhookQueue(): Queue | null {
  if (!getIsRedisAvailable()) return null;

  const redis = getRedisClient()!;
  queue = new Queue(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  });

  logger.info("BullMQ webhook delivery queue created");
  return queue;
}

export function getWebhookQueue(): Queue | null {
  return queue;
}

export async function enqueueWebhookDelivery(deliveryId: string): Promise<void> {
  if (!queue) return;

  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  });

  if (!delivery) {
    logger.warn({ deliveryId }, "Webhook delivery not found, skipping enqueue");
    return;
  }

  const payload = delivery.payload as Record<string, unknown>;

  await queue.add(
    "deliver",
    {
      deliveryId: delivery.id,
      webhookId: delivery.webhookId,
      url: delivery.webhook.url,
      signingKey: delivery.webhook.signingKey,
      payload,
    } satisfies WebhookJobData,
    {
      jobId: delivery.id,
    },
  );

  logger.debug({ deliveryId, webhookId: delivery.webhookId }, "Webhook delivery enqueued");
}

export function createWebhookWorker(): Worker | null {
  if (!getIsRedisAvailable()) return null;

  const redis = getRedisClient()!;
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { deliveryId, url, signingKey, payload } = job.data as WebhookJobData;

      // Atomically claim the row
      const claimed = await prisma.webhookDelivery.updateMany({
        where: { id: deliveryId, status: "pending" },
        data: { status: "processing" },
      });

      if (claimed.count === 0) {
        logger.debug({ deliveryId }, "Delivery already claimed, skipping");
        return;
      }

      const result = await deliverWebhook(url, signingKey, payload);

      if (result.status === "success") {
        await prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: "success",
            attemptCount: job.attemptsMade + 1,
            lastError: null,
          },
        });
        logger.info(
          { deliveryId, webhookId: job.data.webhookId, statusCode: result.statusCode },
          "Webhook delivered successfully",
        );
        Metrics.webhooksDelivered();
      } else {
        const nextAttempt = job.attemptsMade + 1;
        const willRetry = result.willRetry && shouldRetry(nextAttempt);

        let nextRetryAt: Date | null = null;
        if (willRetry) {
          const delayMs = getNextRetryDelay(job.attemptsMade);
          if (delayMs !== null) {
            nextRetryAt = new Date(Date.now() + delayMs);
          }
        }

        await prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: willRetry ? "pending" : "failed",
            attemptCount: nextAttempt,
            nextRetryAt,
            lastError: result.error,
          },
        });

        logger.warn(
          {
            deliveryId,
            webhookId: job.data.webhookId,
            attempt: nextAttempt,
            nextRetryAt,
            error: result.error,
          },
          willRetry ? "Webhook delivery failed, scheduled retry" : "Webhook delivery failed permanently",
        );
        if (willRetry) {
          Metrics.webhookRetries();
        }
        Metrics.webhookDeliveryErrors();

        if (!willRetry) {
          throw new Error(`Permanent failure: ${result.error}`);
        }
      }
    },
    {
      connection: redis,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 1000,
      },
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Webhook delivery job failed");
  });

  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id }, "Webhook delivery job completed");
  });

  logger.info("BullMQ webhook worker started (concurrency: 5)");
  return worker;
}

export async function stopWebhookQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
