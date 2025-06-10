// authAndRateLimiterMiddleware.js
const crypto = require("crypto");
const { supabaseAdmin } = require('../supabaseClient'); // Correctly import supabaseAdmin

// --- Helper: Extract userId from auth token ---
function extractUserIdFromAuthToken(authToken) {
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

// --- Database functions (using Supabase Admin client) ---
async function getLoginRecord(userId, authToken) {
  try {
    const { data, error } = await supabaseAdmin
      .from('manage_logins')
      .select('session_id, is_logged_in, expires_at, method, user_id')
      .eq('user_id', userId)
      .eq('auth_token', authToken)
      .eq('is_logged_in', true)
      .gt('expires_at', new Date().toISOString()) // Check if expires_at is in the future
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error("Supabase error in getLoginRecord:", error);
      return null;
    }

    return data[0] || null; // Return the first record or null if none found
  } catch (error) {
    console.error("Database error in getLoginRecord:", error);
    return null;
  }
}

async function getSessionRecord(sessionId, sessionToken) {
  try {
    const { data: sessionData, error: selectError } = await supabaseAdmin
      .from('sessions')
      .select('session_id, session_token, generated_at, last_access')
      .eq('session_id', sessionId)
      .eq('session_token', sessionToken)
      .limit(1);

    if (selectError) {
      console.error("Supabase select error in getSessionRecord:", selectError);
      return null;
    }

    const sessionRecord = sessionData[0] || null;

    if (sessionRecord) {
      // Update last_access timestamp
      const { error: updateError } = await supabaseAdmin
        .from('sessions')
        .update({ last_access: Date.now() }) // Use Date.now() for BIGINT
        .eq('session_id', sessionId)
        .eq('session_token', sessionToken);

      if (updateError) {
        console.error("Supabase update error in getSessionRecord (non-critical):", updateError);
        // This is often not critical enough to deny access if other checks passed
      }
    }

    return sessionRecord;
  } catch (error) {
    console.error("Database error in getSessionRecord:", error);
    return null;
  }
}

// --- Rate Limiting Setup ---
const rateLimitMap = new Map();
const BLOCK_INCREMENT = 5 * 60 * 1000;  // 5 minutes in ms
const REQUEST_LIMIT = 50;
const TIME_WINDOW = 15 * 1000;           // 15 seconds

async function recordBlockedIp(ip, route, blockStart) {
  console.log(`Recording blocked IP ${ip} for route '${route}'`);
  // TODO: Implement persistent storage for blocked IPs (e.g., database)
  let multiplier = 1; // You could make this dynamic based on repeated blocks
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
          newData[key] = data[key].replace(
            "https://aoycxyazroftyzqlrvpo.supabase.co",
            "https://yourdomain.com/proxy-image" // Replace with your actual proxy domain
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

// --- Route Configuration ---
const PUBLIC_ROUTES = [
  "/login",
  "/signup",
  "/Forgotpassword",
  "/Resetpassword",
  "/Confirmemail",
  // New public authentication endpoints
  "/request-password-reset-otp",
  "/reset-password-with-otp",
  "/verify-email-with-otp",
  "/resend-otp",
  "/check-username",
  // If your frontend uses /desktop/login etc., ensure you account for that here
  // For example, if your client paths are /desktop/login, you need to match them here.
  // Assuming the backend receives raw paths like /login, /signup, etc.
];

function isPublicRoute(url) {
  // Normalize URL to remove query parameters before checking
  const path = url.split('?')[0];
  return PUBLIC_ROUTES.some(route => path.startsWith(route));
}

// --- Main Middleware ---
async function authAndRateLimiterMiddleware(req, res, next) {
  try {
    // 1. Rate Limiting (applies to all routes, always executed first)
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

    // 2. TS Token Validation (applies to all routes, always executed after rate limiting)
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

    if (Date.now() - tsData.generatedAt > 20 * 1000) {
      return res.status(401).json({ error: "Expired TS token. Please refresh or re-login." });
    }

    // 3. Route-based Authentication Logic
    const currentRoute = req.originalUrl || req.url;

    // Handle public routes - these skip full authentication but still get rate limiting and TS token check
    if (isPublicRoute(currentRoute)) {
      console.log(`Public access granted for route: ${currentRoute}`);
      // Apply image URL transformation for all responses, including public ones
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        const transformedData = transformImageUrls(data);
        originalJson(transformedData);
      };
      return next(); // Proceed for public routes (bypassing full auth checks)
    }

    // All other routes are implicitly protected and require full authentication
    console.log(`Protected route accessed: ${currentRoute}`);

    // Get authToken from Authorization header
    const authHeader = req.headers["authorization"];
    let authToken;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      authToken = authHeader.slice(7);
    } else {
      return res.status(401).json({
        error: "Missing or malformed Authorization header",
        code: "LOGIN_REQUIRED",
        message: "Please log in to access this resource"
      });
    }

    // Get sessionToken from custom header
    const sessionToken = req.headers["x-session-token"];
    if (!sessionToken) {
      return res.status(401).json({
        error: "Missing X-Session-Token header",
        code: "LOGIN_REQUIRED",
        message: "Please log in to access this resource"
      });
    }

    // Extract and validate userId from token
    let extractedUserId;
    try {
      extractedUserId = extractUserIdFromAuthToken(authToken);
    } catch (err) {
      console.error("Auth token extraction error:", err.message);
      return res.status(401).json({
        error: "Invalid auth token",
        code: "LOGIN_REQUIRED",
        message: "Please log in to access this resource"
      });
    }

    // Check user ID consistency (optional, but good for security)
    const providedUserId = req.headers["x-user-id"];
    if (providedUserId && providedUserId !== extractedUserId) {
      console.warn(`User ID mismatch: Header ID '${providedUserId}' vs Token ID '${extractedUserId}'`);
      return res.status(401).json({
        error: "User identification mismatch",
        code: "LOGIN_REQUIRED",
        message: "Please log in to access this resource"
      });
    }

    // Validate login record against database (REAL DB CHECK NOW)
    const loginRecord = await getLoginRecord(extractedUserId, authToken);
    if (!loginRecord || !loginRecord.is_logged_in) {
      console.warn(`Invalid or expired login record for userId: ${extractedUserId}`);
      return res.status(401).json({
        error: "Session expired or user not logged in",
        code: "LOGIN_REQUIRED",
        message: "Please log in to access this resource"
      });
    }

    // Check token expiration (redundant if getLoginRecord checks it, but good as a fail-safe)
    if (new Date(loginRecord.expires_at) <= new Date()) {
      console.warn(`Expired token for userId: ${extractedUserId} detected by direct check.`);
      return res.status(401).json({
        error: "Token expired",
        code: "LOGIN_REQUIRED",
        message: "Please log in to access this resource"
      });
    }

    // Validate session record (REAL DB CHECK NOW)
    const sessionRecord = await getSessionRecord(loginRecord.session_id, sessionToken);
    if (!sessionRecord) {
      console.warn(`Invalid session for sessionId: ${loginRecord.session_id}`);
      return res.status(401).json({
        error: "Invalid session",
        code: "LOGIN_REQUIRED",
        message: "Please log in to access this resource"
      });
    }

    // Attach authenticated user data to request
    req.userId = extractedUserId;
    req.sessionId = loginRecord.session_id;
    req.authMethod = loginRecord.method;

    console.log(`Authentication successful for user: ${extractedUserId}`);

    // Apply image URL transformation to all responses (public and protected)
    // This is done after authentication because it modifies the response,
    // and we only want to modify responses for requests that passed initial checks.
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      const transformedData = transformImageUrls(data);
      originalJson(transformedData);
    };

    next(); // All checks passed, proceed to the actual route handler
  } catch (error) {
    console.error("Middleware error:", error);
    // Generic internal server error for unexpected issues in the middleware itself
    return res.status(500).json({ error: "Internal server error." });
  }
}

module.exports = authAndRateLimiterMiddleware;