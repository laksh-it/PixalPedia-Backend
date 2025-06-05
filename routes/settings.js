const express = require('express');
const router = express.Router();

// Assuming you initialize your Supabase client and export it as "supabaseAdmin"
const { supabaseAdmin } = require('../supabaseClient'); // Adjust the import as needed

/**
 * GET /api/settings/:user_id
 * Fetches user settings and profile information.
 *
 * Response format:
 * {
 *   settings: {
 *     id: ...,
 *     username: ...,
 *     email: ...,
 *     google_connected: ...,
 *     github_connected: ...,
 *     public_connected: ...,
 *     created_at: ...,
 *     profile: {
 *       dp: ...,
 *       name: ...,
 *       bio: ...,
 *       social_links: ...,
 *       requested_username: ...,
 *       verified: ...,
 *       verified_at: ...,
 *       created_at: ...,
 *     }
 *   }
 * }
 */
router.get('/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {
    // Fetch stable user data from the "users" table
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, username, email, google_connected, github_connected, public_connected, created_at')
      .eq('id', user_id)
      .single();
      
    if (userError || !userData) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Fetch additional profile info from the "profiles" table
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('dp, name, bio, social_links, requested_username, verified, verified_at, created_at')
      .eq('user_id', user_id)
      .single();

    // Even if profile data isn't found, we return the user data.
    const settings = {
      ...userData,
      profile: profileData || null,
    };

    return res.status(200).json({ settings });
  } catch (err) {
    console.error('Error fetching settings:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * PATCH /api/settings/disconnect
 * Disconnects a provider (Google or GitHub) for the given user.
 *
 * Expects JSON body:
 * {
 *   "user_id": "<user's UUID>",
 *   "provider": "google"   // OR "github"
 * }
 *
 * The route updates the corresponding column (e.g., google_connected) to false.
 */
router.patch('/disconnect', async (req, res) => {
  const { user_id, provider } = req.body;

  if (!user_id || !provider) {
    return res.status(400).json({ error: 'user_id and provider are required.' });
  }

  // Validate the provider to ensure it is one of the supported providers.
  if (!['google', 'github'].includes(provider)) {
    return res.status(400).json({ error: 'Invalid provider. Must be "google" or "github".' });
  }

  // Map the provider to its corresponding database column (e.g., "google_connected")
  const columnToUpdate = `${provider}_connected`;

  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .update({ [columnToUpdate]: false })
      .eq('id', user_id)
      .single();

    if (error) {
      return res.status(500).json({ error: `Failed to disconnect ${provider}: ${error.message}` });
    }

    return res.status(200).json({
      message: `${provider} disconnected successfully.`,
      data,
    });
  } catch (err) {
    console.error('Error disconnecting provider:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
