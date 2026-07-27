import { Router, Request, Response } from "express";
import { redisClient, loadScript } from "../redisClient";

const router = Router();

interface ClientConfig {
  algorithm: "token-bucket" | "sliding-window";
  requestPerSecond: number;
  burstSize: number;
  windowSize: number;
}

router.get("/:clientId", async (req: Request, res: Response) => {
  const { clientId } = req.params;
  if (!clientId) {
    return res.status(400).json({ error: "clientId is required" });
  }

  // Explicit 404 for unconfigured clients — no silent fallback to defaults.
  // This makes misconfiguration visible instead of hiding it.
  let config: ClientConfig;
  try {
    const rawConfig = await redisClient.get(`client:${clientId}:algorithm`);
    if (!rawConfig) {
      return res.status(404).json({
        error: `No config found for client: ${clientId}. Register it via PUT /admin/clients/${clientId}`,
      });
    }
    config = JSON.parse(rawConfig);
  } catch (err) {
    console.error(`Failed to load config for ${clientId}:`, err);
    return res.status(500).json({ error: "Failed to load client config" });
  }

  const current_time = Date.now();
  let allowed: boolean;
  let remaining: number;
  let reset: number;

  try {
    if (config.algorithm === "sliding-window") {
      const scriptSha = await loadScript("slidingWindow");
      const result = (await redisClient.evalSha(scriptSha, {
        keys: [`client:${clientId}:sliding-window`],
        arguments: [
          current_time,
          config.windowSize,
          config.requestPerSecond,
        ].map(String),
      })) as number[];

      allowed = result[0] === 1;
      remaining = result[1] ?? 0;
      reset = result[2] ?? 0;
    } else {
      const scriptSha = await loadScript("tokenBucket");
      const result = (await redisClient.evalSha(scriptSha, {
        keys: [`client:${clientId}:token-bucket`],
        arguments: [
          current_time,
          config.requestPerSecond,
          config.burstSize,
        ].map(String),
      })) as number[];

      allowed = result[0] === 1;
      remaining = result[1] ?? 0;
      reset = result[3] ?? 0; // index 2 = time_until_next_token, 3 = reset_time
    }
  } catch (err) {
    console.error(`Rate-limit check failed for ${clientId}:`, err);
    return res
      .status(500)
      .json({
        allowed: false,
        error: "Internal error during rate limit check",
      });
  }

  res.set({
    "X-RateLimit-Limit": config.requestPerSecond.toString(),
    "X-RateLimit-Remaining": remaining.toString(),
    "X-RateLimit-Reset": reset.toString(),
  });

  if (!allowed) {
    return res.status(429).json({ allowed, remaining, reset });
  }

  return res.status(200).json({ allowed, remaining, reset });
});

export default router;
