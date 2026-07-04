-- KEYS[1] - bucket key
-- ARGV[1] - current timestamp in milliseconds
-- ARGV[2] - requests per second (refill rate)
-- ARGV[3] - maximum burst size (bucket capacity)

local bucket_key = KEYS[1]
local current_time = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local max_burst_size = tonumber(ARGV[3])

-- Get the current state of the token bucket
local bucket = redis.call("HMGET", bucket_key, "tokens", "last_refill_time")

local tokens = tonumber(bucket[1])
local lastRefillTime = tonumber(bucket[2])

-- If the bucket does not exist, initialize it 
--first time we have seen this client, so we need to create the bucket
-- with the maximum burst size and set the last refill time to the current time

if tokens == nil or lastRefillTime == nil then
    tokens = max_burst_size
    lastRefillTime = current_time
    redis.call("HMSET", bucket_key, "tokens", tokens, "last_refill_time", lastRefillTime)
end

-- 1. refill bucket based on time elapsed since last request 
local timeElapsed = (current_time - lastRefillTime)/1000
local refillAmount = timeElapsed * refill_rate

tokens = math.min(tokens + refillAmount, max_burst_size)

-- 2. check if there are enough tokens for the request , try to consume a token

local allowed = 0
if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
end

-- 3. update the bucket state in Redis
redis.call("HMSET", bucket_key, "tokens", tokens, "last_refill_time", current_time)

-- 4 TTL so that the bucket will expire if not used for a while
-- long enought to fully refill the bucket, plus a buffer to account for any delays in processing

local ttl = math.ceil(max_burst_size / refill_rate) + 10
redis.call("EXPIRE", bucket_key, ttl)

--compute the remaining tokens after the request
local remaining_tokens = math.floor(tokens)

-- time atleast 1 second to refill the bucket, so we can compute the time until the next token is available
local time_until_next_token = 0
if tokens < 1 then
    time_until_next_token = math.ceil((1 - tokens) / refill_rate * 1000)
end

local reset_time =current_time + math.ceil((max_burst_size - tokens) / refill_rate * 1000)

return {allowed, remaining_tokens, time_until_next_token, reset_time}
