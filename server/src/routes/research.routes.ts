import { Router } from "express";
import {
  researchExecuteController,
  researchPlanController,
  researchPrecheckController,
} from "../controllers/research.controller";

export const researchRouter = Router();

researchRouter.post("/precheck", researchPrecheckController);
researchRouter.post("/plan", researchPlanController);
researchRouter.post("/execute", researchExecuteController);
