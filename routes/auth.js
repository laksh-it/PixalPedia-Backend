const express = require('express');
const router = express.Router();
const crypto = require('crypto'); // Already imported, good.

// Import your Supabase Admin client
const { supabaseAdmin } = require('../supabaseClient');

// Helper function to decode and verify auth token (remains the same)
const verifyAuthToken = (authToken, userId) => {
  try {
    const secret = process.env.USER_TOKEN_SECRET;
    if (!secret) {
      console.error('USER_TOKEN_SECRET is not set.');
      return false;
    }

    // Remove prefix (20 hex chars) and suffix (16 hex chars)
    const prefixLength = 20;
    const suffixLength = 16;
    
    if (authToken.length <= prefixLength + suffixLength) {
      console.warn('Auth token too short for verification.');
      return false;
    }

    const encodedMerged = authToken.slice(prefixLength, -suffixLength);
    
    // Decode the base64 encoded part
    const merged = Buffer.from(encodedMerged, 'base64').toString();
    
    // Reconstruct the expected merged string
    const splitIndex = Math.floor(secret.length / 2);
    const secretFirst = secret.slice(0, splitIndex);
    const secretSecond = secret.slice(splitIndex);
    const expectedMerged = secretFirst + userId + secretSecond;
    
    return merged === expectedMerged;
  } catch (error) {
    console.error('Error verifying auth token:', error);
    return false;
  }
};

/**
 * GET /api/vailed
 *
 * Verifies user login status by checking:
 * 1. Auth token from Authorization: Bearer header
 * 2. Session token from X-Session-Token header
 * 3. User ID from x-user-id header
 *
 * Returns: { valid: true } if all checks pass (200 OK),
 * { valid: false, message: "..." } with 401 Unauthorized if checks fail.
 */
router.get('/vailed', async (req, res) => {
  // --- Set Cache-Control headers to prevent caching and force 200/401 responses ---
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  // --- End Cache-Control ---

  try {
    // Extract user ID from headers
    const userId = req.headers['x-user-id'];

    if (!userId) {
      console.warn('Validation failed: x-user-id header missing.');
      return res.status(401).json({ valid: false, message: 'User ID missing.' });
    }

    // --- Extract tokens from HEADERS instead of cookies ---
    const authHeader = req.headers['authorization'];
    const sessionToken = req.headers['x-session-token']; // Assuming your frontend sends this header

    let authToken = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      authToken = authHeader.slice(7); // Remove 'Bearer ' prefix
    }

    if (!authToken || !sessionToken) {
      console.warn('Validation failed: Auth or session token missing from headers.');
      return res.status(401).json({ valid: false, message: 'Authentication tokens missing.' });
    }
    // --- End header extraction ---

    // Verify auth token format matches user ID
    if (!verifyAuthToken(authToken, userId)) {
      console.warn('Validation failed: Auth token verification failed.');
      return res.status(401).json({ valid: false, message: 'Invalid authentication token.' });
    }

    // Check manage_logins table for valid auth token and login status
    const { data: loginData, error: loginError } = await supabaseAdmin
      .from('manage_logins')
      .select('session_id, expires_at, is_logged_in')
      .eq('user_id', userId)
      .eq('auth_token', authToken)
      .eq('is_logged_in', true)
      .single();

    if (loginError || !loginData) {
      console.warn('Validation failed: Login record not found or not active.', loginError);
      return res.status(401).json({ valid: false, message: 'Login session not found or inactive.' });
    }

    // Check if token has expired
    const now = new Date();
    const expiresAt = new Date(loginData.expires_at);
    if (now > expiresAt) {
      console.warn('Validation failed: Auth token expired.');
      // Optionally update is_logged_in to false here if you want to revoke on expiration
      return res.status(401).json({ valid: false, message: 'Authentication token expired.' });
    }

    // Check sessions table for valid session token
    const { data: sessionData, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id') // Just need to confirm existence
      .eq('session_id', loginData.session_id)
      .eq('session_token', sessionToken)
      .single();

    if (sessionError || !sessionData) {
      console.warn('Validation failed: Session record not found.', sessionError);
      return res.status(401).json({ valid: false, message: 'Invalid session record.' });
    }

    // All checks passed
    return res.status(200).json({ valid: true, message: "Session is valid." });

  } catch (error) {
    console.error('Error validating user login:', error);
    // For unexpected server errors, respond with a 500 status
    return res.status(500).json({ valid: false, message: 'An internal server error occurred during validation.' });
  }
});

module.exports = router;