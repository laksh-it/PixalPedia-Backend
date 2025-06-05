// fetch.js
const express = require("express");
const { supabase, supabaseAdmin } = require("../supabaseClient"); // Adjust the path as necessary
const router = express.Router();


/**
 * Helper: Enriches a wallpaper object with uploader profile details, like/save flags, hashtags and styles.
 * The uploader_profile includes:
 *   - profile_id (the primary id from the profiles table),
 *   - uploader_username, and uploader_dp.
 */
const enrichWallpaperDetails = async (wallpaper, currentUserId) => {
  // Fetch uploader profile from the profiles table:
  const { data: profileData, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id, username, dp")
    .eq("user_id", wallpaper.user_id)
    .single();

  if (profileError) {
    console.error(
      `Error fetching profile for user ${wallpaper.user_id}:`,
      profileError.message
    );
    wallpaper.profile_id = null;
    wallpaper.uploader_username = "";
    wallpaper.uploader_dp = "";
  } else {
    // Here, profileData.id is the profile id you want to use.
    wallpaper.profile_id = profileData.id;
    wallpaper.uploader_username = profileData.username;
    wallpaper.uploader_dp = profileData.dp;
  }

  // Check if the current user has liked this wallpaper.
  const { data: likeData } = await supabaseAdmin
    .from("wallpaper_likes")
    .select("wallpaper_id")
    .eq("wallpaper_id", wallpaper.id)
    .eq("user_id", currentUserId)
    .maybeSingle();
  wallpaper.isLiked = !!likeData;

  // Check if the current user has saved this wallpaper.
  const { data: savedData } = await supabaseAdmin
    .from("saved_wallpapers")
    .select("wallpaper_id")
    .eq("wallpaper_id", wallpaper.id)
    .eq("user_id", currentUserId)
    .maybeSingle();
  wallpaper.isSaved = !!savedData;

  // Fetch attached hashtags (with the hashtag name).
  const { data: hashtagData, error: hashtagError } = await supabaseAdmin
    .from("wallpaper_hashtags")
    .select("hashtags(name)")
    .eq("wallpaper_id", wallpaper.id);
  wallpaper.hashtags = hashtagError
    ? []
    : hashtagData.map((entry) => entry.hashtags.name);

  // Optionally, fetch attached styles.
  const { data: styleData, error: styleError } = await supabaseAdmin
    .from("wallpaper_styles")
    .select("styles(*)")
    .eq("wallpaper_id", wallpaper.id);
  wallpaper.styles = styleError ? [] : styleData.map((entry) => entry.styles);

  return wallpaper;
};

/**
 * Helper: Enrich an array of wallpapers concurrently.
 */
const enrichWallpapers = async (wallpapers, currentUserId) => {
  return await Promise.all(
    wallpapers.map(async (wp) => await enrichWallpaperDetails(wp, currentUserId))
  );
};

/**
 * GET /profile/:profile_id/:current_user_id
 *
 * Returns the profile details for the given profile id along with all wallpapers
 * uploaded by that user. Each wallpaper is enriched with:
 *  • The uploader’s profile details for navigation (using "id" as profile_id, along with uploader_username and uploader_dp),
 *  • Like/save flags (based on the current user),
 *  • Attached hashtags (and optionally styles).
 *
 * Additionally, this endpoint checks if the current user already follows this profile
 * (using the "user_follows" table) and adds an isFollowed flag to the profile.
 *
 * The endpoint also increments the profile_views count.
 */
router.get("/profile/:profile_id/:current_user_id", async (req, res) => {
  const { profile_id, current_user_id } = req.params;
  try {
    // Retrieve profile record by its primary id
    let { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", profile_id)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: "Profile not found." });
    }

    // Check if current user is following this profile.
    // We assume current_user_id corresponds to the follower (user id)
    // and profile.user_id is the id of the user owning this profile.
    const { data: followData, error: followError } = await supabaseAdmin
      .from("user_follows")
      .select("*")
      .eq("follower_id", current_user_id)
      .eq("following_id", profile.user_id)
      .maybeSingle();

    if (followError) {
      console.error(
        `Error checking follow status for user ${current_user_id} following ${profile.user_id}:`,
        followError.message
      );
      profile.isFollowed = false;
    } else {
      profile.isFollowed = !!followData;
    }

    // Increment profile_views.
    const newViews = (profile.profile_views || 0) + 1;
    await supabaseAdmin
      .from("profiles")
      .update({ profile_views: newViews })
      .eq("id", profile_id);

    // Fetch wallpapers uploaded by this profile.
    const { data: wallpapers, error: wallpapersError } = await supabaseAdmin
      .from("wallpapers")
      .select("*")
      .eq("user_id", profile.user_id);
    if (wallpapersError) {
      console.error("Wallpapers error details:", wallpapersError.message);
      return res.status(500).json({ error: "Error fetching wallpapers." });
    }

    // Enrich each wallpaper with uploader profile info, like/save flags, and hashtags.
    const enrichedWallpapers = await enrichWallpapers(
      wallpapers,
      current_user_id
    );
    profile.wallpapers = enrichedWallpapers;

    return res.status(200).json({ profile });
  } catch (err) {
    console.error("Error fetching profile:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

router.get("/profilegate/:profile_user_id/:current_user_id", async (req, res) => {
  const { profile_user_id, current_user_id } = req.params;
  try {
    // Retrieve profile record using the provided profile_user_id (which is the uploader's user id)
    let { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("user_id", profile_user_id)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: "Profile not found." });
    }

    // If the profile being viewed does not belong to the current user, increment profile_views.
    if (profile_user_id !== current_user_id) {
      const newViews = (profile.profile_views || 0) + 1;
      await supabaseAdmin
        .from("profiles")
        .update({ profile_views: newViews })
        .eq("user_id", profile_user_id);
      profile.profile_views = newViews; // Updating locally so the response includes the latest count
    }

    // Fetch wallpapers from both tables
    const { data: publishedWallpapers, error: publishedError } = await supabaseAdmin
      .from("wallpapers")
      .select("*")
      .eq("user_id", profile_user_id);
      
    const { data: pendingWallpapers, error: pendingError } = await supabaseAdmin
      .from("pending_wallpapers")
      .select("*")
      .eq("user_id", profile_user_id);

    if (publishedError || pendingError) {
      console.error("Error fetching wallpapers:", publishedError?.message, pendingError?.message);
      return res.status(500).json({ error: "Error fetching wallpapers." });
    }

    // Combine both lists
    const allWallpapers = [...(publishedWallpapers || []), ...(pendingWallpapers || [])];

    // Enrich wallpapers using current_user_id (like/save flags)
    const enrichedWallpapers = await enrichWallpapers(allWallpapers, current_user_id);
    profile.wallpapers = enrichedWallpapers;

    return res.status(200).json({ profile });
  } catch (err) {
    console.error("Error fetching profile:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/*
  Endpoint 3: GET /api/wallpaper/:wallpaper_id
  - Fetch wallpaper details along with associated hashtags.
*/
router.get("/wallpaper/:wallpaper_id/:user_id", async (req, res) => {
  // Destructure both wallpaper_id and current user's ID from the route parameters.
  const { wallpaper_id, user_id: currentUserId } = req.params;
  
  try {
    const { data: wallpaper, error } = await supabaseAdmin
      .from("wallpapers")
      .select(`
        *,
        wallpaper_hashtags (
          hashtags(*)
        )
      `)
      .eq("id", wallpaper_id)
      .single();
      
    if (error || !wallpaper) {
      return res.status(404).json({ error: "Wallpaper not found." });
    }
    
    // Enrich the wallpaper using the provided current user id.
    let enrichedWallpaper = wallpaper;
    if (currentUserId) {
      enrichedWallpaper = await enrichWallpaperDetails(wallpaper, currentUserId);
    }
    
    return res.status(200).json({ wallpaper: enrichedWallpaper });
  } catch (err) {
    console.error("Error fetching wallpaper:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/*
  Endpoint 4a: GET /api/profile/:profile_id/followers/:user_id
  - Uses the given profile_id to fetch the target user's user_id from the profiles table.
  - Queries user_follows (which stores user IDs) where following_id equals the target user's ID.
  - Retrieves the follower profiles and annotates each profile with isFollowed (does the current user follow that profile?).
*/
router.get("/:profile_id/followers/:user_id", async (req, res) => {
  const { profile_id, user_id } = req.params;
  try {
    // Get the target user's ID using the provided profile_id.
    const { data: targetProfile, error: targetProfileError } = await supabaseAdmin
      .from("profiles")
      .select("user_id")
      .eq("id", profile_id)
      .single();
    if (targetProfileError || !targetProfile) {
      return res.status(404).json({ error: "Profile not found" });
    }
    const targetUserId = targetProfile.user_id;

    // Query the follow table to get follower user IDs (where following_id equals targetUserId).
    const { data: followsData, error: followsError } = await supabaseAdmin
      .from("user_follows")
      .select("follower_id")
      .eq("following_id", targetUserId);
    if (followsError) {
      return res.status(500).json({ error: "Error fetching followers" });
    }
    const followerIds = followsData.map(f => f.follower_id);

    // Fetch profiles for these follower user IDs.
    const { data: followerProfiles, error: profilesError } = await supabaseAdmin
      .from("profiles")
      .select("id, user_id, name, dp, username, bio")
      .in("user_id", followerIds);
    if (profilesError) {
      return res.status(500).json({ error: "Error fetching follower profiles" });
    }

    // Get the list of profiles that the current user already follows.
    const { data: currentFollowingData, error: cfError } = await supabaseAdmin
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", user_id);
    if (cfError) {
      console.error("Error fetching current following:", cfError.message);
    }
    const currentFollowingIds = currentFollowingData
      ? currentFollowingData.map(item => item.following_id)
      : [];

    // Annotate each follower profile with an isFollowed flag.
    const followersWithFollowStatus = followerProfiles.map(profile => ({
      ...profile,
      isFollowed: currentFollowingIds.includes(profile.user_id)
    }));

    return res.status(200).json({ followers: followersWithFollowStatus });
  } catch (err) {
    console.error("Error fetching followers:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/*
  Endpoint 4b: GET /api/profile/:profile_id/following/:user_id
  - Uses the provided profile_id to fetch its associated user_id.
  - Queries user_follows where follower_id equals the target user's user_id.
  - Retrieves profiles that the target user follows and marks each with isFollowed (does the current user follow that profile?).
*/
router.get("/:profile_id/following/:user_id", async (req, res) => {
  const { profile_id, user_id } = req.params;
  try {
    // Get the target user's ID using the provided profile_id.
    const { data: targetProfile, error: targetProfileError } = await supabaseAdmin
      .from("profiles")
      .select("user_id")
      .eq("id", profile_id)
      .single();
    if (targetProfileError || !targetProfile) {
      return res.status(404).json({ error: "Profile not found" });
    }
    const targetUserId = targetProfile.user_id;

    // Query the follow table to get the users that the target user is following.
    const { data: followingData, error: followingError } = await supabaseAdmin
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", targetUserId);
    if (followingError) {
      return res.status(500).json({ error: "Error fetching following list" });
    }
    const followingIds = followingData.map(f => f.following_id);

    // Fetch profiles for these followed user IDs.
    const { data: followingProfiles, error: profilesError } = await supabaseAdmin
      .from("profiles")
      .select("id, user_id, name, dp, username, bio")
      .in("user_id", followingIds);
    if (profilesError) {
      return res.status(500).json({ error: "Error fetching following profiles" });
    }

    // Get the list of profiles that the current user already follows.
    const { data: currentFollowingData, error: cfError } = await supabaseAdmin
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", user_id);
    if (cfError) {
      console.error("Error fetching current user's following:", cfError.message);
    }
    const currentFollowingIds = currentFollowingData
      ? currentFollowingData.map(item => item.following_id)
      : [];

    // Annotate each followed profile with an isFollowed flag.
    const followingWithFollowStatus = followingProfiles.map(profile => ({
      ...profile,
      isFollowed: currentFollowingIds.includes(profile.user_id)
    }));

    return res.status(200).json({ following: followingWithFollowStatus });
  } catch (err) {
    console.error("Error fetching following:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/*
  Endpoint 4: GET /api/profile/:user_id/not-approved
  - Fetch images that were not approved for the user.
*/
/*
  Endpoint 4: GET /api/profile/:user_id/not-approved
  - Fetch images that were not approved (pending approval) for the user.
*/
router.get("/:user_id/not-approved", async (req, res) => {
  const { user_id } = req.params;
  try {
    const { data: images, error } = await supabaseAdmin
      .from("pending_wallpapers")  // Updated table name
      .select("*")
      .eq("user_id", user_id);
      
    if (error) {
      return res.status(500).json({ error: "Error fetching pending images." });
    }
    return res.status(200).json({ notApprovedImages: images });
  } catch (err) {
    console.error("Error fetching pending images:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/*
  Endpoint 5: GET /api/profile/:user_id/not-approved
  - Fetch images that were not approved for the user.
*/
router.get("/verified/:user_id/status", async (req, res) => {
  const { user_id } = req.params;
  try {
    // Fetch the user's profile data to get the verification status (true or false)
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("verified")
      .eq("user_id", user_id)
      .single();

    if (profileError || !profileData) {
      console.error("Error fetching profile:", profileError?.message);
      return res.status(404).json({ error: "User profile not found." });
    }

    // Return only the user's verification status.
    return res.status(200).json({ verified: profileData.verified });
  } catch (err) {
    console.error("Error fetching verification status:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/*
  Endpoint 6: GET /api/wallpaper/:wallpaper_id/likes/:user_id
  - Retrieves the list of user IDs who liked the wallpaper.
  - Fetches each liker's profile from the profiles table.
  - Annotates each liker with isFollowed (does the current user follow that liker?).
*/
router.get("/wallpaper/:wallpaper_id/likes/:user_id", async (req, res) => {
  const { wallpaper_id, user_id } = req.params;
  try {
    // Get wallpaper likes records.
    const { data: likesData, error: likesError } = await supabaseAdmin
      .from("wallpaper_likes")
      .select("user_id")
      .eq("wallpaper_id", wallpaper_id);
    if (likesError) {
      return res.status(500).json({ error: "Error fetching likes" });
    }
    const likerIds = likesData.map(like => like.user_id);
    if (likerIds.length === 0) {
      return res.status(200).json({ likes: [] });
    }

    // Fetch profiles for each liking user.
    const { data: likerProfiles, error: profilesError } = await supabaseAdmin
      .from("profiles")
      .select("id, user_id, name, dp, username")
      .in("user_id", likerIds);
    if (profilesError) {
      return res.status(500).json({ error: "Error fetching liker profiles" });
    }

    // Get the list of profiles that the current user already follows.
    const { data: currentFollowingData, error: cfError } = await supabaseAdmin
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", user_id);
    if (cfError) {
      console.error("Error fetching current user's following:", cfError.message);
    }
    const currentFollowingIds = currentFollowingData
      ? currentFollowingData.map(item => item.following_id)
      : [];

    // Annotate each liker profile with an isFollowed flag.
    const likesWithFollowStatus = likerProfiles.map(profile => ({
      ...profile,
      isFollowed: currentFollowingIds.includes(profile.user_id)
    }));

    return res.status(200).json({ likes: likesWithFollowStatus });
  } catch (err) {
    console.error("Error fetching wallpaper likes:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/*
  Endpoint 7: GET /api/profile/:user_id/verification
  - Fetch verification request status for the user.
*/
router.get("/profile/:user_id/verification", async (req, res) => {
  const { user_id } = req.params;
  try {
    // Query the verification_requests table.
    const { data: verification, error } = await supabaseAdmin
      .from("verification_requests")
      .select("*")
      .eq("user_id", user_id)
      .single();
    if (error) {
      // If no record, return null (or you could choose to return a proper message)
      return res.status(200).json({ verification: null });
    }
    return res.status(200).json({ verification });
  } catch (err) {
    console.error("Error fetching verification request:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/*
  New Endpoint 8: POST /api/saved
  - Save a wallpaper for a user.
  - Request body should contain: { user_id, wallpaper_id }
*/
router.post("/saved", async (req, res) => {
  try {
    const { user_id, wallpaper_id } = req.body;
    if (!user_id || !wallpaper_id) {
      return res.status(400).json({ error: "User ID and wallpaper ID are required." });
    }

    // Check if the wallpaper is already saved
    const { data: existing, error: existError } = await supabaseAdmin
      .from("saved_wallpapers")
      .select("*")
      .eq("user_id", user_id)
      .eq("wallpaper_id", wallpaper_id)
      .single();

    if (existing) {
      return res.status(400).json({ error: "Wallpaper already saved." });
    }

    // Insert a new saved record
    const { data, error } = await supabaseAdmin
      .from("saved_wallpapers")
      .insert([{ user_id, wallpaper_id }])
      .single();

    if (error) {
      return res.status(500).json({ error: "Error saving wallpaper: " + error.message });
    }

    return res.status(200).json({ message: "Wallpaper saved successfully.", saved: data });
  } catch (err) {
    console.error("Error saving wallpaper:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/*
  New Endpoint 9: DELETE /api/saved
  - Remove a saved wallpaper record.
  - Request body should contain: { user_id, wallpaper_id }
*/
router.delete("/saved/delete", async (req, res) => {
  try {
    const { user_id, wallpaper_id } = req.body;
    if (!user_id || !wallpaper_id) {
      return res.status(400).json({ error: "User ID and wallpaper ID are required." });
    }

    const { error } = await supabaseAdmin
      .from("saved_wallpapers")
      .delete()
      .eq("user_id", user_id)
      .eq("wallpaper_id", wallpaper_id);

    if (error) {
      return res.status(500).json({ error: "Error removing saved wallpaper: " + error.message });
    }

    return res.status(200).json({ message: "Saved wallpaper removed successfully." });
  } catch (err) {
    console.error("Error removing saved wallpaper:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/*
  New Endpoint 10: GET /api/saved/:user_id
  - Fetch all saved wallpapers for a given user.
  - Uses an embedded relationship to fetch wallpaper details.
*/
router.get("/saved/:user_id", async (req, res) => {
  const { user_id } = req.params;
  try {
    const { data: savedRecords, error } = await supabaseAdmin
      .from("saved_wallpapers")
      .select(`
        *,
        wallpapers(*)
      `)
      .eq("user_id", user_id);

    if (error) {
      return res.status(500).json({ error: "Error fetching saved wallpapers: " + error.message });
    }
    
    // Extract the wallpaper object from each saved record.
    let wallpapers = savedRecords.map(record => record.wallpapers);
    
    // Enrich each wallpaper with uploader profile details, like/save flags and hashtags.
    wallpapers = await enrichWallpapers(wallpapers, user_id);

    return res.status(200).json({ saved: wallpapers });
  } catch (err) {
    console.error("Error fetching saved wallpapers:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/*
  New Endpoint 11: DELETE /api/followers/:user_id/remove/:follower_id
  - Remove a follower from the current user's follower list.
  - Here, `user_id` represents the user being followed, and `follower_id` is the follower to remove.
*/
router.delete("/followers/:user_id/remove/:profile_id", async (req, res) => {
  const { user_id, profile_id } = req.params;
  
  try {
    if (!user_id || !profile_id) {
      return res.status(400).json({ error: "User ID and Profile ID are required." });
    }

    // Fetch the follower's user ID using profile_id from the profiles table.
    // This gets the follower's profile, which contains their user_id.
    const { data: followerProfile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("user_id")
      .eq("id", profile_id)
      .single();

    if (profileError || !followerProfile) {
      return res.status(404).json({ error: "Follower profile not found." });
    }

    const follower_id = followerProfile.user_id; // This is the follower's user ID.

    // Remove the follower record from the user_follows table.
    // Here, user_id (from params) is the ID of the "following" (the user being unfollowed),
    // and the fetched follower_id is the one who is unfollowing.
    const { error: removeError } = await supabaseAdmin
      .from("user_follows")
      .delete()
      .eq("following_id", user_id)
      .eq("follower_id", follower_id);

    if (removeError) {
      return res.status(500).json({ error: "Error removing follower: " + removeError.message });
    }
    
    // --------- Update the user's follower count ---------
    // Fetch the current followers_count for the user being unfollowed.
    const { data: userProfileData, error: userProfileError } = await supabaseAdmin
      .from("profiles")
      .select("followers_count")
      .eq("user_id", user_id)
      .single();

    if (userProfileError || !userProfileData) {
      return res.status(404).json({ error: "User profile not found for updating follower count." });
    }
    
    const currentFollowerCount = userProfileData.followers_count || 0;
    const newFollowerCount = Math.max(0, currentFollowerCount - 1);

    // Update the followers_count for the user.
    const { error: updateUserError } = await supabaseAdmin
      .from("profiles")
      .update({ followers_count: newFollowerCount })
      .eq("user_id", user_id);

    if (updateUserError) {
      return res.status(500).json({ error: "Error updating follower count: " + updateUserError.message });
    }
    
    // --------- Update the follower's following count ---------
    // Fetch the current following_count for the follower.
    const { data: followerProfileCount, error: followerProfileError } = await supabaseAdmin
      .from("profiles")
      .select("following_count")
      .eq("user_id", follower_id)
      .single();

    if (followerProfileError || !followerProfileCount) {
      return res.status(404).json({ error: "Follower profile not found for updating following count." });
    }

    const currentFollowingCount = followerProfileCount.following_count || 0;
    const newFollowingCount = Math.max(0, currentFollowingCount - 1);

    // Update the following_count for the follower.
    const { error: updateFollowingError } = await supabaseAdmin
      .from("profiles")
      .update({ following_count: newFollowingCount })
      .eq("user_id", follower_id);

    if (updateFollowingError) {
      return res.status(500).json({ error: "Error updating following count: " + updateFollowingError.message });
    }

    return res
      .status(200)
      .json({ message: "Follower removed and both counts updated successfully." });
      
  } catch (err) {
    console.error("Error removing follower:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// New Endpoint 11: GET /api/categories-thumbnails
// For each category, fetch the category data and one random wallpaper (as a thumbnail) from that category.
// New Endpoint: GET /api/categories
// This endpoint fetches all categories along with their saved thumbnail URL.
router.get("/categories", async (req, res) => {
  try {
    console.log("Fetching categories along with thumbnails...");
    
    // Query categories along with related thumbnail data using auto‑embedding.
    const { data, error } = await supabaseAdmin
      .from("categories")
      .select(`
        id,
        name,
        category_thumbnails ( thumbnail_url )
      `);

    if (error) {
      console.error("Error fetching categories with thumbnails:", error.message);
      return res.status(500).json({ error: "Error fetching categories." });
    }

    // Filter only categories that have at least one thumbnail.
    const filteredCategories = data.filter(
      (cat) => cat.category_thumbnails && cat.category_thumbnails.length > 0
    );

    // Map to flatten the result.
    const categories = filteredCategories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      thumbnail_url: cat.category_thumbnails[0].thumbnail_url
    }));

    console.log("Successfully fetched", categories.length, "categories with thumbnails.");
    return res.status(200).json({ categories });
  } catch (err) {
    console.error("Error in /categories endpoint:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/*
  New Endpoint: GET /api/category-wallpapers/:category_id
  - Fetches all wallpapers associated with a specific category.
  - Joins the wallpapers table via the wallpaper_categories junction table.
*/
router.get("/category-wallpapers/:category_id/:user_id", async (req, res) => {
  const { category_id, user_id: currentUserId } = req.params;
  
  if (!category_id) {
    return res.status(400).json({ error: "Category ID is required." });
  }
  
  try {
    // Use the junction table to fetch wallpapers associated with the category.
    const { data, error } = await supabaseAdmin
      .from("wallpaper_categories")
      .select("wallpapers(*)")
      .eq("category_id", category_id);
      
    if (error) {
      return res.status(500).json({ error: "Error fetching wallpapers for category: " + error.message });
    }
    
    // Flatten the result: each row contains a "wallpapers" object (or an array).
    let wallpapers = data.map((row) => row.wallpapers).flat();
    
    // Enrich each wallpaper if currentUserId is provided.
    if (currentUserId) {
      wallpapers = await enrichWallpapers(wallpapers, currentUserId);
    }
    
    return res.status(200).json({ wallpapers });
  } catch (err) {
    console.error("Error fetching wallpapers for category:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

router.get("/username-change-status/:user_id", async (req, res) => {
  const { user_id } = req.params;

  try {
    // Fetch the profile using user_id
    const { data: profile, error } = await supabaseAdmin
      .from("profiles")
      .select("username_change_requested_at")
      .eq("user_id", user_id)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: "Profile not found." });
    }

    const lastChangedAt = profile.username_change_requested_at;
    const cooldownPeriodDays = 30; // 30-day cooldown period

    let canChange = true;
    let nextChangeAvailableAt = null;

    if (lastChangedAt) {
      const lastChangedDate = new Date(lastChangedAt);
      const nextChangeDate = new Date(
        lastChangedDate.getTime() + cooldownPeriodDays * 24 * 60 * 60 * 1000
      );

      const now = new Date();

      if (now < nextChangeDate) {
        canChange = false;
        nextChangeAvailableAt = nextChangeDate;
      }
    }

    // Format the dates to return just the YYYY-MM-DD part
    const formattedLastChangedAt = lastChangedAt ? lastChangedAt.split("T")[0] : null;
    const formattedNextChangeAvailableAt = nextChangeAvailableAt ? nextChangeAvailableAt.toISOString().split("T")[0] : null;

    return res.status(200).json({
      canChange,
      lastChangedAt: formattedLastChangedAt,
      nextChangeAvailableAt: formattedNextChangeAvailableAt,
    });
  } catch (err) {
    console.error("Error checking username change status:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});


module.exports = router;
