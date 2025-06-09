const crypto = require("crypto");

// --- Helper: Extract userId from auth token ---
function extractUserIdFromAuthToken(authToken) {
  // Assuming the authToken provided here is the raw token string
  // after removing "Bearer " prefix if it exists.
  // Token structure:
  // token = [prefix (20 hex chars)] + [base64(secretFirst + userId + secretSecond)] + [suffix (16 hex chars)]
  const prefixLength = 20;
  const suffixLength = 16;

  if (authToken.length <= prefixLength + suffixLength) {
    throw new Error("Invalid token length");
  }

  const encodedMerged = authToken.substring(prefixLength, authToken.length - suffixLength);
  const merged = Buffer.from(encodedMerged, "base64").toString("utf8");

  const secret = process.env.USER_TOKEN_SECRET;
  if (!secret) {
    throw new Error("USER_TOKEN_SECRET is not set in environment variables");
  }

  const splitIndex = Math.floor(secret.length / 2);
  const secretFirst = secret.slice(0, splitIndex);
  const secretSecond = secret.slice(splitIndex);

  if (!merged.startsWith(secretFirst) || !merged.endsWith(secretSecond)) {
    throw new Error("Invalid token format");
  }

  const userId = merged.substring(secretFirst.length, merged.length - secretSecond.length);
  return userId;
}

// --- Placeholder DB functions ---
// Replace these functions with actual database queries.
async function getLoginRecord(userId, authToken) {
  // Example: Query the manage_logins table
  // WHERE user_id = $1, auth_token = $2, is_logged_in = true, and expires_at > NOW();
  // In a real application, you'd fetch the login record associated with the authToken.
  // For now, returning a mock.
  console.log(`DB Lookup: Checking login record for userId: ${userId}, authToken: ${authToken}`);
  return {
    session_id: "sample-session-id-from-db", // Replace with actual session id from DB
    is_logged_in: true,                      // Should be true for an active login.
  };
}

async function getSessionRecord(sessionId, sessionToken) {
  // Retrieve session details from the sessions table using both sessionId and sessionToken.
  // In production, you would also verify the session_token from the database against the one provided.
  console.log(`DB Lookup: Checking session record for sessionId: ${sessionId}, sessionToken: ${sessionToken}`);
  return {
    // In production, this record would also include a 'session_token' value that you'd verify.
    // user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", // You might remove these from session record if not needed
    // language: "en-US",
    // platform: "MacIntel",
    // screen_resolution: "1440x900",
    // timezone_offset: -240,
  };
}

// --- Rate Limiting Setup ---
const rateLimitMap = new Map();
const BLOCK_INCREMENT = 5 * 60 * 1000;  // 5 minutes in ms
const REQUEST_LIMIT = 50;
const TIME_WINDOW = 15 * 1000;           // 15 seconds

// Assume 'pool' is your database connection pool, e.g., from 'pg' library
// const pool = require('./db_connection'); // You'll need to define this

// --- Function to record blocked IPs in the database ---
async function recordBlockedIp(ip, route, blockStart) {
  // Placeholder: Implement actual database interaction here if 'pool' is defined.
  // For now, just logging and simulating a block.
  console.log(`Simulating IP ${ip} being blocked for route '${route}'`);
  let multiplier = 1;
  // If you have a 'pool' uncomment and adjust this section for real DB interaction.
  /*
  try {
    const res = await pool.query(
      "SELECT id, request_count, block_end FROM blocked_ips WHERE ip = $1 ORDER BY created_at DESC LIMIT 1",
      [ip]
    );

    if (res.rows.length > 0) {
      const lastRecord = res.rows[0];
      if (new Date(lastRecord.block_end) > new Date()) {
        multiplier = lastRecord.request_count + 1;
      }
    }

    const newBlockDuration = BLOCK_INCREMENT * multiplier;
    const newBlockEnd = blockStart + newBlockDuration;

    const insertQuery = `
      INSERT INTO blocked_ips (ip, request_count, first_request, last_request, block_start, block_end, route)
      VALUES ($1, $2, to_timestamp($3/1000.0), to_timestamp($3/1000.0), to_timestamp($4/1000.0), to_timestamp($5/1000.0), $6)
    `;
    await pool.query(insertQuery, [
      ip,
      multiplier,
      blockStart,
      blockStart,
      newBlockEnd,
      route,
    ]);

    console.log(
      `IP ${ip} blocked for route '${route}' with multiplier ${multiplier}. New block end: ${new Date(newBlockEnd).toISOString()}`
    );

    return newBlockEnd;
  } catch (err) {
    console.error("Error recording blocked IP:", err);
    throw err;
  }
  */
  // For simulation:
  const newBlockDuration = BLOCK_INCREMENT * multiplier;
  const newBlockEnd = blockStart + newBlockDuration;
  return newBlockEnd;
}

// --- Helper to transform image URLs in response data ---
function transformImageUrls(data) {
  if (Array.isArray(data)) {
    return data.map(transformImageUrls);
  } else if (data !== null && typeof data === "object") {
    const newData = {};
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        if (/image_url/i.test(key) && typeof data[key] === "string") {
          // Replace with your actual domain/proxy path
          newData[key] = data[key].replace(
            "https://aoycxyazroftyzqlrvpo.supabase.co",
            "https://yourdomain.com/proxy-image"
          );
        } else {
          newData[key] = transformImageUrls(data[key]);
        }
      }
    }
    return newData;
  }
  return data;
}

// --- Combined Middleware ---
async function authAndRateLimiterMiddleware(req, res, next) {
  try {
    // 1. Rate Limiting
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    let rateData = rateLimitMap.get(ip) || { firstRequestTime: now, requestCount: 0, blockUntil: 0 };

    if (now < (rateData.blockUntil || 0)) {
      return res.status(429).json({ error: "Too many requests. Your IP is temporarily blocked." });
    }
    if (now - rateData.firstRequestTime > TIME_WINDOW) {
      rateData.firstRequestTime = now;
      rateData.requestCount = 1;
    } else {
      rateData.requestCount++;
      if (rateData.requestCount > REQUEST_LIMIT) {
        const newBlockUntil = await recordBlockedIp(ip, req.originalUrl, now);
        rateData.blockUntil = newBlockUntil;
        rateLimitMap.set(ip, rateData);
        return res.status(429).json({ error: "Too many requests. Your IP is temporarily blocked." });
      }
    }
    rateLimitMap.set(ip, rateData);

    // 2. TS Token Validation (remains the same as it's typically a device/session fingerprint)
    const tsToken = req.headers["ts"] || req.query.ts;
    if (!tsToken) {
      return res.status(400).json({ error: "Missing TS token" });
    }
    let tsData;
    try {
      const decodedTs = Buffer.from(tsToken, "base64").toString("utf8");
      tsData = JSON.parse(decodedTs);
    } catch (err) {
      return res.status(400).json({ error: "Invalid TS token" });
    }
    // Check if the TS token is older than 20 seconds.
    if (Date.now() - tsData.generatedAt > 20 * 1000) {
      return res.status(401).json({ error: "Expired TS token. Please refresh or re-login." }); // Changed message slightly
    }

    // 3. Conditional Auth & Session Validation
    // If "login" header is "false" or "authentication" header is "public", skip further auth.
    const loginHeader = req.headers["login"];
    const authMethod = req.headers["authentication"]; // Assuming "authentication: public" is still used for public routes
    if (
      (loginHeader && loginHeader.toString().toLowerCase() === "false") ||
      (authMethod && authMethod.toString().toLowerCase() === "public")
    ) {
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        const transformedData = transformImageUrls(data);
        originalJson(transformedData);
      };
      return next();
    }

    // --- FULL AUTHENTICATION REQUIRED (PROTECTED ROUTES) ---

    // Get authToken from Authorization header
    const authHeader = req.headers["authorization"];
    let authToken;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      authToken = authHeader.slice(7, authHeader.length); // Remove "Bearer " prefix
    } else {
      return res.status(401).json({ error: "Missing or malformed Authorization header (Bearer token required)." });
    }

    // Get sessionToken from custom header
    const sessionToken = req.headers["x-session-token"]; // Assuming 'X-Session-Token'
    if (!sessionToken) {
      return res.status(401).json({ error: "Missing X-Session-Token header." });
    }

    let extractedUserId;
    try {
      extractedUserId = extractUserIdFromAuthToken(authToken);
    } catch (err) {
      console.error("Auth token extraction error:", err.message);
      return res.status(401).json({ error: "Invalid auth token." });
    }

    // It's good practice to ensure the user ID sent in headers matches the one in the token.
    let providedUserId = req.headers["x-user-id"];
    if (providedUserId && providedUserId !== extractedUserId) {
      console.warn(`User ID mismatch: Header ID '${providedUserId}' vs Token ID '${extractedUserId}'`);
      return res.status(401).json({ error: "User identification mismatch." });
    }

    // Validate login status from manage_logins table using both userId and authToken
    const loginRecord = await getLoginRecord(extractedUserId, authToken);
    if (!loginRecord || !loginRecord.is_logged_in) {
      console.warn(`Login record not found or inactive for userId: ${extractedUserId}`);
      return res.status(401).json({ error: "Session expired or user not logged in. Please re-login." });
    }

    // Validate session record exists using session_id from loginRecord and the sessionToken
    const sessionRecord = await getSessionRecord(loginRecord.session_id, sessionToken);
    if (!sessionRecord) {
      console.warn(`Session record not found for sessionId: ${loginRecord.session_id}`);
      return res.status(401).json({ error: "Invalid session. Please re-login." });
    }

    // Optionally attach user/session data to the request object for downstream handlers
    req.userId = extractedUserId;
    req.sessionId = loginRecord.session_id;
    // req.sessionData = sessionRecord; // If you need full session details

    // Override res.json to transform image URLs.
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      const transformedData = transformImageUrls(data);
      originalJson(transformedData);
    };

    next();
  } catch (error) {
    console.error("Middleware error:", error);
    // Be careful not to expose too much internal error detail in production
    return res.status(500).json({ error: "Internal server error." });
  }
}

module.exports = authAndRateLimiterMiddleware;