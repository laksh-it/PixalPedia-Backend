// follow.js

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// Initialize Supabase client (ensure environment variables are set)
const SUPABASE_URL = process.env.SUPABASE_URL; // e.g., "https://your-project.supabase.co"
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * POST /follow
 * Request JSON body should include:
 * {
 *   "follower_id": "UUID of the follower",
 *   "following_id": "UUID of the followed user"
 * }
 * 
 * The endpoint looks up each user's profile ID from the profiles table,
 * inserts the follow record into user_follows, and then updates the
 * respective follower and following counts in the profiles table.
 */
router.post('/follow', async (req, res) => {
  try {
    const { follower_id, following_id } = req.body;
    
    if (!follower_id || !following_id) {
      return res.status(400).json({ error: "follower_id and following_id are required." });
    }
    
    if (follower_id === following_id) {
      return res.status(400).json({ error: "You cannot follow yourself." });
    }
    
    // Retrieve follower's profile.
    const { data: followerProfile, error: followerProfileError } = await supabaseAdmin
      .from('profiles')
      .select('id, following_count')
      .eq('user_id', follower_id)
      .single();
    if (followerProfileError || !followerProfile) {
      return res.status(500).json({ error: "Follower profile not found." });
    }
    
    // Retrieve followed user's profile.
    const { data: followedProfile, error: followedProfileError } = await supabaseAdmin
      .from('profiles')
      .select('id, followers_count')
      .eq('user_id', following_id)
      .single();
    if (followedProfileError || !followedProfile) {
      return res.status(500).json({ error: "Followed user's profile not found." });
    }
    
    // Check if the follow relationship already exists.
    const { data: existingFollow } = await supabaseAdmin
      .from('user_follows')
      .select('*')
      .eq('follower_id', follower_id)
      .eq('following_id', following_id)
      .single();
    if (existingFollow) {
      return res.status(400).json({ error: "Already following this user." });
    }
    
    // Insert the follow record including profile IDs.
    const { error: insertError } = await supabaseAdmin
      .from('user_follows')
      .insert([{
        follower_id,
        follower_profile_id: followerProfile.id,
        following_id,
        following_profile_id: followedProfile.id
      }]);
    if (insertError) {
      return res.status(500).json({ error: "Error inserting follow relationship." });
    }
    
    // Update follower's profile: increment following_count.
    const newFollowingCount = (followerProfile.following_count || 0) + 1;
    const { error: updateFollowerError } = await supabaseAdmin
      .from('profiles')
      .update({ following_count: newFollowingCount })
      .eq('user_id', follower_id);
    if (updateFollowerError) {
      return res.status(500).json({ error: "Failed to update follower profile." });
    }
    
    // Update followed user's profile: increment followers_count.
    const newFollowersCount = (followedProfile.followers_count || 0) + 1;
    const { error: updateFollowedError } = await supabaseAdmin
      .from('profiles')
      .update({ followers_count: newFollowersCount })
      .eq('user_id', following_id);
    if (updateFollowedError) {
      return res.status(500).json({ error: "Failed to update followed user's profile." });
    }
    
    return res.status(200).json({ message: "Followed successfully." });
  } catch (err) {
    console.error("Error during follow:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /unfollow
 * Request JSON body should include:
 * {
 *   "follower_id": "UUID of the follower",
 *   "following_id": "UUID of the followed user"
 * }
 * 
 * The endpoint removes the follow record and updates the follow counters
 * on both the follower's and followed user's profiles.
 */
router.post('/unfollow', async (req, res) => {
  try {
    const { follower_id, following_id } = req.body;
    
    if (!follower_id || !following_id) {
      return res.status(400).json({ error: "follower_id and following_id are required." });
    }
    
    if (follower_id === following_id) {
      return res.status(400).json({ error: "Cannot unfollow yourself." });
    }
    
    // Check if the follow relationship exists.
    const { data: existingFollow } = await supabaseAdmin
      .from('user_follows')
      .select('*')
      .eq('follower_id', follower_id)
      .eq('following_id', following_id)
      .single();
    if (!existingFollow) {
      return res.status(400).json({ error: "Not currently following this user." });
    }
    
    // Delete the follow record.
    const { error: deleteError } = await supabaseAdmin
      .from('user_follows')
      .delete()
      .eq('follower_id', follower_id)
      .eq('following_id', following_id);
    if (deleteError) {
      return res.status(500).json({ error: "Error removing follow relationship." });
    }
    
    // Retrieve follower's profile.
    const { data: followerProfile, error: followerProfileError } = await supabaseAdmin
      .from('profiles')
      .select('following_count')
      .eq('user_id', follower_id)
      .single();
    if (followerProfileError || !followerProfile) {
      return res.status(500).json({ error: "Follower profile not found." });
    }
    
    // Retrieve followed user's profile.
    const { data: followedProfile, error: followedProfileError } = await supabaseAdmin
      .from('profiles')
      .select('followers_count')
      .eq('user_id', following_id)
      .single();
    if (followedProfileError || !followedProfile) {
      return res.status(500).json({ error: "Followed user's profile not found." });
    }
    
    // Update follower's profile: decrement following_count.
    const newFollowingCount = Math.max((followerProfile.following_count || 0) - 1, 0);
    const { error: updateFollowerError } = await supabaseAdmin
      .from('profiles')
      .update({ following_count: newFollowingCount })
      .eq('user_id', follower_id);
    if (updateFollowerError) {
      return res.status(500).json({ error: "Failed to update follower profile." });
    }
    
    // Update followed user's profile: decrement followers_count.
    const newFollowersCount = Math.max((followedProfile.followers_count || 0) - 1, 0);
    const { error: updateFollowedError } = await supabaseAdmin
      .from('profiles')
      .update({ followers_count: newFollowersCount })
      .eq('user_id', following_id);
    if (updateFollowedError) {
      return res.status(500).json({ error: "Failed to update followed user's profile." });
    }
    
    return res.status(200).json({ message: "Unfollowed successfully." });
  } catch (err) {
    console.error("Error during unfollow:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
