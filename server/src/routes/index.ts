import { Router } from "express";
import { healthRouter } from "./health.routes";
import { researchRouter } from "./research.routes";

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use("/research", researchRouter);

