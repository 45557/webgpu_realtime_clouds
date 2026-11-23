const PIXEL_BUDGETS = [800_000, 1_100_000, 1_540_000, 2_150_000, 3_000_000, 4_000_000];
const PROMOTE_MS = 9.5;
const REDUCE_MS = 13.5;
const INSPECTION_DELAY_MS = 300;

export function createFluidRenderResolution() {
  let tier = 0;
  let average = 0;
  let healthyFrames = 0;
  let slowFrames = 0;
  let settling = 8;
  let cooldown = 0;
  let entryTime = 0;
  let framesAtTier = 0;
  let lastEdit = -Infinity;
  const promoteBelow = PIXEL_BUDGETS.map(() => PROMOTE_MS);

  function moveTo(nextTier, cooldownFrames) {
    tier = nextTier;
    average = 0;
    healthyFrames = 0;
    slowFrames = 0;
    framesAtTier = 0;
    settling = 4;
    cooldown = cooldownFrames;
  }

  return {
    get pixelBudget() { return PIXEL_BUDGETS[tier]; },
    frameQuality(now, inspecting, editing) {
      if (!inspecting || editing) lastEdit = now;
      const inspection = inspecting && now - lastEdit >= INSPECTION_DELAY_MS;
      return {pixelBudget: inspection ? PIXEL_BUDGETS.at(-1) : PIXEL_BUDGETS[tier], inspection};
    },
    recordFrame(ms, nativePixels) {
      if (!Number.isFinite(ms) || ms <= 0) return;
      if (settling > 0) {
        settling--;
        return;
      }
      framesAtTier++;
      const sample = Math.min(ms, 40);
      average = average ? average + (sample - average) * .125 : sample;
      slowFrames = average >= REDUCE_MS ? slowFrames + 1 : 0;
      if (tier > 0 && slowFrames >= 6) {
        // Require more headroom before retrying a tier that just missed
        // the frame budget. A steady view must not cycle between sizes.
        const lower = tier - 1;
        const estimate = average * PIXEL_BUDGETS[lower] / PIXEL_BUDGETS[tier];
        const lowerTime = framesAtTier < 90 && entryTime ? entryTime : estimate;
        promoteBelow[lower] = Math.min(PROMOTE_MS, lowerTime * .8);
        entryTime = 0;
        moveTo(lower, 90);
        return;
      }

      if (cooldown > 0) cooldown--;
      const canGrow = tier < PIXEL_BUDGETS.length - 1 && nativePixels > PIXEL_BUDGETS[tier];
      healthyFrames = canGrow && cooldown === 0 && average < promoteBelow[tier] ? healthyFrames + 1 : 0;
      if (healthyFrames >= 36) {
        entryTime = average;
        moveTo(tier + 1, 0);
      }
    },
  };
}
