const crypto = require("crypto");

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

// --- Database functions (replace with your actual DB client) ---
// Assuming you're using something like pg, supabase, or prisma
async function getLoginRecord(userId, authToken) {
  try {
    // Replace 'db' with your actual database client
    const query = `
      SELECT 
        session_id, 
        is_logged_in, 
        expires_at,
        method,
        user_id
      FROM public.manage_logins 
      WHERE user_id = $1 
        AND auth_token = $2 
        AND is_logged_in = true 
        AND expires_at > NOW()
      ORDER BY created_at DESC 
      LIMIT 1
    `;
    
    // Example with pg client - replace with your DB implementation
    // const result = await db.query(query, [userId, authToken]);
    // return result.rows[0] || null;
    
    console.log(`DB Query: ${query} with params [${userId}, ${authToken}]`);
    // Placeholder return - replace with actual query
    return {
      session_id: "sample-session-id-from-db",
      is_logged_in: true,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
      method: "google",
      user_id: userId
    };
  } catch (error) {
    console.error("Database error in getLoginRecord:", error);
    return null;
  }
}

async function getSessionRecord(sessionId, sessionToken) {
  try {
    const query = `
      SELECT 
        session_id,
        session_token,
        generated_at,
        last_access
      FROM public.sessions 
      WHERE session_id = $1 
        AND session_token = $2
      LIMIT 1
    `;
    
    // Example with pg client - replace with your DB implementation
    // const result = await db.query(query, [sessionId, sessionToken]);
    // const sessionRecord = result.rows[0];
    
    console.log(`DB Query: ${query} with params [${sessionId}, ${sessionToken}]`);
    
    // Placeholder return - replace with actual query
    const sessionRecord = {
      session_id: sessionId,
      session_token: sessionToken,
      generated_at: Date.now() - 1000, // 1 second ago
      last_access: Date.now() - 500 // 0.5 seconds ago
    };
    
    if (sessionRecord) {
      // Update last_access timestamp
      const updateQuery = `
        UPDATE public.sessions 
        SET last_access = $1 
        WHERE session_id = $2 AND session_token = $3
      `;
      // await db.query(updateQuery, [Date.now(), sessionId, sessionToken]);
      console.log(`DB Update: ${updateQuery} with params [${Date.now()}, ${sessionId}, ${sessionToken}]`);
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
  // You should also store this in a database table for persistence
  let multiplier = 1;
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

// --- Route Configuration ---
const PROTECTED_ROUTES = [
  '/api/wallpapers',
  '/api/user/profile',
  '/api/user/settings',
  '/api/user/favorites',
];

const PUBLIC_ROUTES = [
  '/api/public/wallpapers',
  '/api/health',
  '/api/status',
  '/api/auth/login',
  '/api/auth/register',
];

function isProtectedRoute(url) {
  return PROTECTED_ROUTES.some(route => url.startsWith(route));
}

function isPublicRoute(url) {
  return PUBLIC_ROUTES.some(route => url.startsWith(route));
}

// --- Main Middleware ---
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

    // 2. TS Token Validation
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
    const authMethod = req.headers["authentication"];
    
    // Handle public routes or explicit public access
    if (isPublicRoute(currentRoute) || authMethod === "public") {
      console.log(`Public access granted for route: ${currentRoute}`);
      
      // Still apply image URL transformation
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        const transformedData = transformImageUrls(data);
        originalJson(transformedData);
      };
      return next();
    }

    // Protected routes require full authentication
    if (isProtectedRoute(currentRoute)) {
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

      // Check user ID consistency
      const providedUserId = req.headers["x-user-id"];
      if (providedUserId && providedUserId !== extractedUserId) {
        console.warn(`User ID mismatch: Header ID '${providedUserId}' vs Token ID '${extractedUserId}'`);
        return res.status(401).json({ 
          error: "User identification mismatch", 
          code: "LOGIN_REQUIRED",
          message: "Please log in to access this resource"
        });
      }

      // Validate login record against database
      const loginRecord = await getLoginRecord(extractedUserId, authToken);
      if (!loginRecord || !loginRecord.is_logged_in) {
        console.warn(`Invalid login record for userId: ${extractedUserId}`);
        return res.status(401).json({ 
          error: "Session expired or user not logged in", 
          code: "LOGIN_REQUIRED",
          message: "Please log in to access this resource"
        });
      }

      // Check token expiration
      if (new Date(loginRecord.expires_at) <= new Date()) {
        console.warn(`Expired token for userId: ${extractedUserId}`);
        return res.status(401).json({ 
          error: "Token expired", 
          code: "LOGIN_REQUIRED",
          message: "Please log in to access this resource"
        });
      }

      // Validate session record
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
    }

    // Apply image URL transformation to all responses
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      const transformedData = transformImageUrls(data);
      originalJson(transformedData);
    };

    next();
  } catch (error) {
    console.error("Middleware error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
}

module.exports = authAndRateLimiterMiddleware;