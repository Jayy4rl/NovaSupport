import { prisma } from "../db.js";
import { logger } from "../logger.js";

function profileLockKey(profileId: string): bigint {
  let h = 0n;
  for (let i = 0; i < profileId.length; i++) {
    h = (h * 31n + BigInt(profileId.charCodeAt(i))) & 0x7FFFFFFFFFFFFFFFn;
  }
  return h;
}

export async function checkAndAwardBadges(profileId: string, prismaClient = prisma): Promise<void> {
  const lockKey = profileLockKey(profileId);

  try {
    await prismaClient.$transaction(async (tx) => {
      // Serialize concurrent badge checks for the same profile using a
      // transaction-scoped advisory lock. Concurrent callers block until the
      // current check commits, then each runs with the latest DB state rather
      // than being silently dropped.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      const badges = await tx.badge.findMany();
      if (badges.length === 0) return;

      const existingAwards = await tx.profileBadge.findMany({
        where: { profileId },
        select: { badgeId: true },
      });
      const awardedBadgeIds = new Set(existingAwards.map((a) => a.badgeId));

      if (awardedBadgeIds.size === badges.length) return;

      const [txCount, uniqueSupporters, totalsByAsset, milestonesReached] = await Promise.all([
        tx.supportTransaction.count({
          where: { profileId, status: { not: "failed" } },
        }),
        tx.supportTransaction.findMany({
          where: { profileId, supporterAddress: { not: null }, status: { not: "failed" } },
          distinct: ["supporterAddress"],
          select: { supporterAddress: true },
        }),
        tx.supportTransaction.groupBy({
          by: ["assetCode", "assetIssuer"],
          where: { profileId, status: { not: "failed" } },
          _sum: { amount: true },
        }),
        tx.milestone.count({
          where: { profileId, status: "reached" },
        }),
      ]);

      const xlmTotal = totalsByAsset
        .filter((g) => g.assetCode === "XLM" && g.assetIssuer === null)
        .reduce((sum, g) => sum + Number(g._sum.amount ?? 0), 0);

      for (const badge of badges) {
        if (awardedBadgeIds.has(badge.id)) continue;

        let shouldAward = false;

        switch (badge.criteria) {
          case "first_support":
            shouldAward = txCount >= 1;
            break;
          case "ten_supporters":
            shouldAward = uniqueSupporters.length >= 10;
            break;
          case "total_100_xlm":
            shouldAward = xlmTotal >= 100;
            break;
          case "milestone_reached":
            shouldAward = milestonesReached >= 1;
            break;
          default:
            logger.warn(
              { criteria: badge.criteria, badgeId: badge.id },
              "Unknown badge criteria — badge will never be auto-awarded",
            );
            break;
        }

        if (shouldAward) {
          try {
            await tx.profileBadge.create({
              data: { profileId, badgeId: badge.id },
            });
            logger.info(
              { profileId, badgeName: badge.name },
              "Badge auto-awarded",
            );
          } catch (e: any) {
            if (e?.code !== "P2002") throw e;
          }
        }
      }
    }, { timeout: 30000 });
  } catch (err) {
    logger.error(
      { err, profileId },
      "Error in checkAndAwardBadges",
    );
  }
}
