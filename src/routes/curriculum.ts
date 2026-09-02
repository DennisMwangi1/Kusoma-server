import { Router } from "express";

import { badRequest } from "../lib/errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { getCurriculumNode, getCurriculumTree } from "../services/cbc-api-client.js";

export const curriculumRouter = Router();
curriculumRouter.use(authenticate);

/**
 * GET /curriculum/node/:id — single node detail.
 *
 * MUST be registered before /:grade/:subject: both are two segments, so
 * `/curriculum/node/abc` would otherwise match with grade="node".
 */
curriculumRouter.get("/node/:id", requirePermission("curriculum:read"), async (req, res, next) => {
  try {
    res.json({ data: await getCurriculumNode(req.params.id!) });
  } catch (err) {
    next(err);
  }
});

/** GET /curriculum/:grade/:subject — proxied to the CBC API (§10). */
curriculumRouter.get("/:grade/:subject", requirePermission("curriculum:read"), async (req, res, next) => {
  try {
    const grade = Number(req.params.grade);
    if (!Number.isInteger(grade) || grade < 1 || grade > 13) throw badRequest("Grade must be 1-13");
    res.json({ data: await getCurriculumTree(grade, req.params.subject!) });
  } catch (err) {
    next(err);
  }
});
