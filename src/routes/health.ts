import { Router, type IRouter } from "express";
import * as zod from "zod";

const router: IRouter = Router();

const HealthCheckResponse = zod.object({
  status: zod.string(),
});

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
