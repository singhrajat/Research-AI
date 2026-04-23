import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { apiRouter } from "./routes";
import { errorMiddleware } from "./middleware/error.middleware";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.use("/api", apiRouter);

app.use(errorMiddleware);

