const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Import your Supabase Admin client
const { supabaseAdmin } = require('../supabaseClient');

// Helper function to decode and verify auth token
const verifyAuthToken = (authToken, userId) => {
  try {
    const secret = process.env.USER_TOKEN_SECRET;
    if (!secret) {
      return false;
    }

    // Remove prefix (20 hex chars) and suffix (16 hex chars)
    const prefixLength = 20;
    const suffixLength = 16;
    
    if (authToken.length <= prefixLength + suffixLength) {
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
 * 1. Auth token from cookie against manage_logins table
 * 2. Session token from cookie against sessions table
 * 3. User ID from x-user-id header
 * 
 * Returns: { valid: true } if all checks pass, else { valid: false }
 */
router.get('/vailed', async (req, res) => {
  try {
    // Extract user ID from headers
    const userId = req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(200).json({ valid: false });
    }

    // Extract tokens from cookies
    const cookies = req.headers.cookie;
    if (!cookies) {
      return res.status(200).json({ valid: false });
    }

    // Parse cookies to get auth_token and session_token
    const cookieMap = {};
    cookies.split(';').forEach(cookie => {
      const [key, value] = cookie.trim().split('=');
      if (key && value) {
        cookieMap[key] = decodeURIComponent(value);
      }
    });

    const authToken = cookieMap.auth_token;
    const sessionToken = cookieMap.session_token;

    if (!authToken || !sessionToken) {
      return res.status(200).json({ valid: false });
    }

    // Verify auth token format matches user ID
    if (!verifyAuthToken(authToken, userId)) {
      return res.status(200).json({ valid: false });
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
      return res.status(200).json({ valid: false });
    }

    // Check if token has expired
    const now = new Date();
    const expiresAt = new Date(loginData.expires_at);
    if (now > expiresAt) {
      return res.status(200).json({ valid: false });
    }

    // Check sessions table for valid session token
    const { data: sessionData, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('session_id', loginData.session_id)
      .eq('session_token', sessionToken)
      .single();

    if (sessionError || !sessionData) {
      return res.status(200).json({ valid: false });
    }

    // All checks passed
    return res.status(200).json({ valid: true });

  } catch (error) {
    console.error('Error validating user login:', error);
    return res.status(200).json({ valid: false });
  }
});

module.exports = router;