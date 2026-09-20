import "dotenv/config";
import express, { Request, Response } from "express";
import checkRouter from "./routes/check";
import adminRouter from "./routes/admin";
import { connectRedis, getRedisClient } from "./redisClient";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger";

const app = express();
app.use(express.json());


app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/docs.json", (_req, res) => res.json(swaggerSpec));


app.get("/health", async (_req: Request, res: Response) => {
  try {
    await getRedisClient().ping();
    res.json({ status: "ok", redis: "connected" });
  } catch (err) {
    res.status(503).json({ status: "error", redis: "disconnected" });
  }
});

app.use("/check", checkRouter);
app.use("/admin", adminRouter);

const PORT = process.env.PORT || 3000;

connectRedis()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Tollgate is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to Redis:", err);
    process.exit(1);
  });
