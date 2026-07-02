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
    -- add the current timestamp to the sorted set
    redis.call('ZADD', key, current_timestamp, current_timestamp .. '-'..math.random())
    allowed=1
    current_count = current_count + 1
end

--set expiration date TTL  so old client does not keep the key forever
redis.call('PEXPIRE', key, window_size)

local remaining = max_requests - current_count

local resetAt = current_timestamp + window_size

return {allowed, remaining, resetAt}