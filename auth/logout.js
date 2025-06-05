const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../supabaseClient'); // Import Supabase client

/*
  New Endpoint: POST /api/logout/:user_id
  - Logs out any active sessions of the specified user by setting is_logged_in to false.
  - Only the user_id (in the URL) is required.
*/
router.post("/logout/:user_id", async (req, res) => {
  const { user_id } = req.params;

  try {
    // Fetch any active sessions for the user.
    const { data, error: fetchError } = await supabaseAdmin
      .from("manage_logins")
      .select("session_id")
      .eq("user_id", user_id)
      .eq("is_logged_in", true);

    if (fetchError) {
      console.error("Error fetching active sessions:", fetchError.message);
      return res.status(500).json({ error: "Error fetching session: " + fetchError.message });
    }

    if (!data || data.length === 0) {
      return res.status(400).json({ error: "No active session found for this user." });
    }

    // Update all active sessions for the user to mark them as logged out.
    const { error: updateError } = await supabaseAdmin
      .from("manage_logins")
      .update({ is_logged_in: false })
      .eq("user_id", user_id)
      .eq("is_logged_in", true);

    if (updateError) {
      console.error("Error updating session:", updateError.message);
      return res.status(500).json({ error: "Error logging out: " + updateError.message });
    }

    return res.status(200).json({ message: "Logged out successfully." });
  } catch (err) {
    console.error("Error during logout:", err.message);
    return res.status(500).json({ error: "Internal server error: " + err.message });
  }
});

module.exports = router;
