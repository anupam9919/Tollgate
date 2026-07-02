import {createClient} from "redis";
import type {RedisClientType} from "redis";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL missing");
}

const client = createClient({ url: redisUrl });

export async function connectRedis(): Promise<RedisClientType> {
    if(!client.isOpen) {
        await client.connect();
    }
    return client;
}
export { client };
