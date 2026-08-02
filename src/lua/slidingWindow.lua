-- KEYS[1] = sliding window key
-- ARGV[1] = current timestamp in milliseconds
-- ARGV[2] = window size in milliseconds
-- ARGV[3] = maximum number of requests allowed in the window

local key = KEYS[1]
local current_timestamp = tonumber(ARGV[1])
local window_size = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])

local window_start = current_timestamp - window_size

-- remove timestamps that are outside the window
redis.call('ZREMRANGEBYSCORE', key, 0, window_start)

-- get the current number of requests in the window
local current_count = redis.call('ZCARD', key)

local allowed=0
if current_count < max_requests then
    -- Use an atomic sequence counter for uniqueness instead of math.random()
    -- math.random() in Lua (Redis) can produce collisions under high concurrency;
    -- INCR on a sidecar key is atomic and guaranteed unique per window key.
    local seq = redis.call('INCR', key .. ':seq')
    redis.call('ZADD', key, current_timestamp, current_timestamp .. '-' .. seq)
    allowed=1
    current_count = current_count + 1
end

--set expiration date TTL  so old client does not keep the key forever
redis.call('PEXPIRE', key, window_size)
redis.call('PEXPIRE', key .. ':seq', window_size)

local remaining = max_requests - current_count

-- resetAt = oldest entry's score + windowSize (when the first entry in the current
-- window will fall off). Falls back to now + windowSize when the window is empty.
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetAt
if oldest and oldest[2] then
    resetAt = tonumber(oldest[2]) + window_size
else
    resetAt = current_timestamp + window_size
end

return {allowed, remaining, resetAt}