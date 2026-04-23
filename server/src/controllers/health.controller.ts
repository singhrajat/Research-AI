import type { RequestHandler } from "express";
import { getHealth } from "../services/health.service";

export const healthController: RequestHandler = (_req, res) => {
  res.json(getHealth());
};

