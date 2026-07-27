import { Router, Request, Response } from 'express';
import { redisClient, loadScript } from '../redisClient';

const router = Router();

interface CheckRequestBody {
    algorithm: 'token-bucket' | 'sliding-window';
    requestPerSecond: number;
    burstSize: number;
    windowSize: number; // milliseconds
}

const DEFAULT_CONFIG: CheckRequestBody = {
    algorithm: 'token-bucket',
    requestPerSecond: 5,
    burstSize: 10,
    windowSize: 60000 // fixed: was 60 (ms bug -> instant expiry)
};

router.get('/:clientId', async (req: Request, res: Response) => {
    const { clientId } = req.params;
    if (!clientId) {
        return res.status(400).json({ allowed: false });
    }

    const current_time = Date.now();

    let config: CheckRequestBody;
    try {
        const rawConfig = await redisClient.get(`client:${clientId}:algorithm`);
        config = rawConfig ? JSON.parse(rawConfig) : DEFAULT_CONFIG;
    } catch {
        config = DEFAULT_CONFIG;
    }

    let allowed: boolean;
    let remaining: number;
    let reset: number;

    try {
        if (config.algorithm === 'sliding-window') {
            const scriptSha = await loadScript('slidingWindow');
            const result = await redisClient.evalSha(scriptSha, {
                keys: [`client:${clientId}:sliding-window`],
                arguments: [current_time, config.windowSize, config.requestPerSecond].map(String)
            }) as number[];

            allowed = result[0] === 1;
            remaining = result[1] ?? 0;
            reset = result[2] ?? 0;     
        } else {
            const scriptSha = await loadScript('tokenBucket');
            const result = await redisClient.evalSha(scriptSha, {
                keys: [`client:${clientId}:token-bucket`],
                arguments: [current_time, config.requestPerSecond, config.burstSize].map(String)
            }) as number[];

            allowed = result[0] === 1;
            remaining = result[1] ?? 0;
            reset = result[3] ?? 0;
        }
    } catch (err) {
        console.error(`rate-limit check failed for ${clientId}:`, err);
        return res.status(500).json({ allowed: false, error: 'internal error' });
    }

    res.set({
        'X-RateLimit-Limit': config.requestPerSecond.toString(),
        'X-RateLimit-Remaining': remaining.toString(),
        'X-RateLimit-Reset': reset.toString()
    });

    if(!allowed) {
        return res.status(429).json({ allowed, remaining, reset });
    }

    return res.status(200).json({ allowed, remaining, reset });
});

export default router;