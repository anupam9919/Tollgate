import path from "path";
import {createClient} from "redis";
import type {RedisClientType} from "redis";
import fs from "fs";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL missing");
}

const redisClient = createClient({ url: redisUrl });

// load the script LUA scripts sha once at startup , reuse via EVALSHA
const scriptShaMap: Record<string, string> = {};

async function loadScript(scriptName: string): Promise<string> {
    if(scriptShaMap[scriptName]) {
        return scriptShaMap[scriptName];
    }

    const scriptPath =path.join(__dirname, 'lua', `${scriptName}.lua`);
    const source= fs.readFileSync(scriptPath, 'utf8');
    const sha = await redisClient.scriptLoad(source);
    scriptShaMap[scriptName] = sha; 

    return sha;
}

async function connectRedis(): Promise<RedisClientType> {
    if(!redisClient.isOpen) {
        await redisClient.connect();
    }
    return redisClient;
}

export { redisClient, connectRedis, loadScript };
