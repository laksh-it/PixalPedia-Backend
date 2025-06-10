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
  console.log(`DB Lookup: Checking login record for userId: ${userId}, authToken: ${authToken}`);
  return {
    session_id: "sample-session-id-from-db",
    is_logged_in: true,
  };
}

async function getSessionRecord(sessionId, sessionToken) {
  console.log(`DB Lookup: Checking session record for sessionId: ${sessionId}, sessionToken: ${sessionToken}`);
  return {
    // Session record data
  };
}

// --- Rate Limiting Setup ---
const rateLimitMap = new Map();
const BLOCK_INCREMENT = 5 * 60 * 1000;  // 5 minutes in ms
const REQUEST_LIMIT = 50;
const TIME_WINDOW = 15 * 1000;           // 15 seconds

// --- Function to record blocked IPs in the database ---
async function recordBlockedIp(ip, route, blockStart) {
  console.log(`Simulating IP ${ip} being blocked for route '${route}'`);
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

// --- List of routes that require authentication ---
const PROTECTED_ROUTES = [
  '/api/wallpapers',
  '/api/user/profile',
  '/api/user/settings',
  '/api/user/favorites',
  // Add more protected routes as needed
];

// --- Helper to check if route requires authentication ---
function isProtectedRoute(url) {
  return PROTECTED_ROUTES.some(route => url.startsWith(route));
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

    // 3. Check if this is a protected route
    const currentRoute = req.originalUrl || req.url;
    const routeRequiresAuth = isProtectedRoute(currentRoute);

    // 4. Conditional Auth & Session Validation
    const loginHeader = req.headers["login"];
    const authMethod = req.headers["authentication"];
    
    // If route doesn't require auth OR explicitly marked as public, skip auth
    if (
      !routeRequiresAuth || 
      (loginHeader && loginHeader.toString().toLowerCase() === "false") ||
      (authMethod && authMethod.toString().toLowerCase() === "public")
    ) {
      // But if it's a protected route and login is false, return specific error
      if (routeRequiresAuth && loginHeader && loginHeader.toString().toLowerCase() === "false") {
        return res.status(401).json({ 
          error: "Authentication required", 
          code: "LOGIN_REQUIRED",
          message: "Please log in to access this resource"
        });
      }
      
      // For non-protected routes or public access, continue normally
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
      authToken = authHeader.slice(7, authHeader.length);
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

    // Check user ID match
    let providedUserId = req.headers["x-user-id"];
    if (providedUserId && providedUserId !== extractedUserId) {
      console.warn(`User ID mismatch: Header ID '${providedUserId}' vs Token ID '${extractedUserId}'`);
      return res.status(401).json({ 
        error: "User identification mismatch", 
        code: "LOGIN_REQUIRED",
        message: "Please log in to access this resource"
      });
    }

    // Validate login status
    const loginRecord = await getLoginRecord(extractedUserId, authToken);
    if (!loginRecord || !loginRecord.is_logged_in) {
      console.warn(`Login record not found or inactive for userId: ${extractedUserId}`);
      return res.status(401).json({ 
        error: "Session expired or user not logged in", 
        code: "LOGIN_REQUIRED",
        message: "Please log in to access this resource"
      });
    }

    // Validate session record
    const sessionRecord = await getSessionRecord(loginRecord.session_id, sessionToken);
    if (!sessionRecord) {
      console.warn(`Session record not found for sessionId: ${loginRecord.session_id}`);
      return res.status(401).json({ 
        error: "Invalid session", 
        code: "LOGIN_REQUIRED",
        message: "Please log in to access this resource"
      });
    }

    // Attach user data to request
    req.userId = extractedUserId;
    req.sessionId = loginRecord.session_id;

    // Override res.json to transform image URLs
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