import type { ErrorRequestHandler } from "express";

export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof (err as any)?.status === "number" ? (err as any).status : 500;
  const message =
    typeof (err as any)?.message === "string" ? (err as any).message : "Internal Server Error";

  res.status(status).json({ message });
};

