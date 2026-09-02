import { Router } from "express";
import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";

export const onboardingRouter = Router();
onboardingRouter.use(authenticate);

/** POST /onboarding/complete — marks users.onboarded = true. */
onboardingRouter.post("/complete", requirePermission("students:write"), async (req, res, next) => {
  try {
    const [updated] = await db
      .update(users)
      .set({ onboarded: true, updatedAt: new Date() })
      .where(eq(users.id, req.user!.id))
      .returning({ id: users.id, onboarded: users.onboarded });
    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});
