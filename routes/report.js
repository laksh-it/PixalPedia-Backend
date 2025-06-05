// report.js

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// Initialize Supabase client – ensure your environment variables are set
const SUPABASE_URL = process.env.SUPABASE_URL;  // e.g., "https://your-project.supabase.co"
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * POST /report
 * Request JSON body should include:
 * {
 *   "reporter_id": "UUID of the reporting user",
 *   "element_type": "user" | "profile" | "wallpaper",
 *   "element_id": "UUID of the reported element",
 *   "reason": "A brief explanation of why this element is being reported"
 * }
 */
router.post('/report', async (req, res) => {
  try {
    const { reporter_id, element_type, element_id, reason } = req.body;

    // Validate required fields.
    if (!reporter_id || !element_type || !element_id || !reason) {
      return res.status(400).json({ error: "reporter_id, element_type, element_id and reason are required." });
    }

    // Validate that the element_type is one of the allowed types.
    const allowedTypes = ['user', 'profile', 'wallpaper'];
    if (!allowedTypes.includes(element_type.toLowerCase())) {
      return res.status(400).json({ error: "Invalid element_type. Must be one of 'user', 'profile', or 'wallpaper'." });
    }

    // Insert the report record into the database.
    const { data, error } = await supabaseAdmin
      .from('reports')
      .insert([{
        reporter_id,
        element_type: element_type.toLowerCase(),
        element_id,
        reason
      }])
      .single();

    if (error) {
      console.error("Error recording report:", error.message);
      return res.status(500).json({ error: "Error recording report." });
    }

    return res.status(200).json({ message: "Report submitted successfully.", report: data });
  } catch (err) {
    console.error("Unexpected error:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
