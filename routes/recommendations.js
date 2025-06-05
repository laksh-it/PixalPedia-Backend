const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../supabaseClient"); // Adjust the path as needed

/**
 * Fallback: Fetch trending wallpapers based on view_count or another metric.
 */
const getTrendingWallpapers = async () => {
  try {
    console.log("Fetching trending wallpapers as fallback...");
    const { data, error } = await supabaseAdmin
      .from("wallpapers")
      .select("*")
      .order("view_count", { ascending: false })
      .limit(30);

    if (error) {
      console.error("Error fetching trending wallpapers:", error.message);
      return [];
    }
    return data;
  } catch (err) {
    console.error("Error in getTrendingWallpapers:", err.message);
    return [];
  }
};

/**
 * Helper function to get up-to N wallpapers grouped by unique category OR style.
 * (Existing function remains unchanged)
 */
const getWallpapersByAssociation = async (
  userId,
  engagementTable, // e.g., "wallpaper_likes", "saved_wallpapers", "wallpaper_downloads", etc.
  timeField,       // e.g., "created_at", "saved_at"
  junctionTable,   // e.g., "wallpaper_categories" or "wallpaper_styles"
  junctionField,   // e.g., "category_id" or "style_id"
  limitPerSection
) => {
  const results = [];
  const seenAssociations = new Set();

  // Build select query string; include "count" if available.
  let selectFields = `wallpaper_id, ${timeField}`;
  const tablesWithCount = ["wallpaper_views", "wallpaper_downloads", "wallpaper_shares"];
  if (tablesWithCount.includes(engagementTable)) {
    selectFields += ", count";
  }

  const orderColumn = tablesWithCount.includes(engagementTable) ? "count" : timeField;

  const { data, error } = await supabaseAdmin
    .from(engagementTable)
    .select(selectFields)
    .eq("user_id", userId)
    .order(orderColumn, { ascending: false });
  if (error) {
    console.error(`Error fetching from ${engagementTable}:`, error.message);
    return results;
  }

  // Iterate over each record and pick one per unique association.
  for (const record of data) {
    const wpId = record.wallpaper_id;
    // Get the associated category or style for this wallpaper.
    const { data: assocData, error: assocError } = await supabaseAdmin
      .from(junctionTable)
      .select(`${junctionField}`)
      .eq("wallpaper_id", wpId)
      .limit(1);
    if (assocError) {
      console.error(`Error fetching association for wallpaper ${wpId}:`, assocError.message);
      continue;
    }
    if (assocData && assocData.length > 0) {
      const assocId = assocData[0][junctionField];
      if (!seenAssociations.has(assocId)) {
        seenAssociations.add(assocId);
        // Fetch full wallpaper details.
        const { data: wpData, error: wpError } = await supabaseAdmin
          .from("wallpapers")
          .select("*")
          .eq("id", wpId)
          .single();
        if (!wpError && wpData) {
          results.push(wpData);
        }
      }
    }
    if (results.length >= limitPerSection) break;
  }
  return results;
};

/**
 * Get the last 5 uploaded wallpapers.
 */
const getLatestUploads = async () => {
  try {
    const { data, error } = await supabaseAdmin
      .from("wallpapers")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) {
      console.error("Error fetching latest uploads:", error.message);
      return [];
    }
    return data;
  } catch (err) {
    console.error("Error in getLatestUploads:", err.message);
    return [];
  }
};

/**
 * Fetch 5 wallpapers from followed users (each followed user's latest wallpaper).
 */
const getFollowedProfilesWallpapers = async (userId) => {
  try {
    // First, get followed user IDs.
    const { data: follows, error: followError } = await supabaseAdmin
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", userId);
    if (followError) {
      console.error("Error fetching followed profiles:", followError.message);
      return [];
    }
    const followedIds = follows.map((f) => f.following_id);
    if (followedIds.length === 0) return [];

    // For each followed user, get their latest wallpaper.
    const { data: wallpapers, error: wpError } = await supabaseAdmin
      .from("wallpapers")
      .select("*")
      .in("user_id", followedIds)
      .order("created_at", { ascending: false })
      .limit(5);
    if (wpError) {
      console.error("Error fetching wallpapers from followed profiles:", wpError.message);
      return [];
    }
    return wallpapers;
  } catch (err) {
    console.error("Error in getFollowedProfilesWallpapers:", err.message);
    return [];
  }
};

/**
 * Custom recommendation system:
 *   - Segment 1: Last 5 uploads.
 *   - Segment 2: 5 wallpapers from liked wallpaper associations (using wallpaper_likes AND wallpaper_categories).
 *   - Segment 3: 5 wallpapers from saved wallpaper associations (using saved_wallpapers AND wallpaper_categories).
 *   - Segment 4: 5 wallpapers from followed profiles' latest uploads.
 *   - Segment 5: 10 wallpapers from download associations (using wallpaper_downloads AND wallpaper_categories).
 * 
 * Then duplicates are removed, trending wallpapers are used to fill any gap below 30, and the final list is shuffled.
 */
const recommendWallpapersCustom = async (userId) => {
  try {
    // Segment 1: Latest uploads.
    const s1 = await getLatestUploads();

    // Segment 2: From liked wallpapers based on category association.
    const s2 = await getWallpapersByAssociation(
      userId,
      "wallpaper_likes",
      "created_at",
      "wallpaper_categories",
      "category_id",
      5
    );

    // Segment 3: From saved wallpapers based on category association.
    const s3 = await getWallpapersByAssociation(
      userId,
      "saved_wallpapers",
      "saved_at",
      "wallpaper_categories",
      "category_id",
      5
    );

    // Segment 4: From followed profiles.
    const s4 = await getFollowedProfilesWallpapers(userId);

    // Segment 5: From downloads based on category association.
    const s5 = await getWallpapersByAssociation(
      userId,
      "wallpaper_downloads",
      "created_at",
      "wallpaper_categories",
      "category_id",
      10
    );

    // Combine all segments.
    let combined = [...s1, ...s2, ...s3, ...s4, ...s5];

    // Remove duplicate wallpapers (by id).
    const uniqueMap = new Map();
    for (const wp of combined) {
      if (!uniqueMap.has(wp.id)) {
        uniqueMap.set(wp.id, wp);
      }
    }
    let uniqueWallpapers = Array.from(uniqueMap.values());

    // If less than 30 wallpapers, fill with trending wallpapers.
    if (uniqueWallpapers.length < 30) {
      const trending = await getTrendingWallpapers();
      for (const wp of trending) {
        if (!uniqueMap.has(wp.id)) {
          uniqueWallpapers.push(wp);
          uniqueMap.set(wp.id, wp);
          if (uniqueWallpapers.length >= 30) break;
        }
      }
    }

    // Randomly shuffle final list.
    for (let i = uniqueWallpapers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [uniqueWallpapers[i], uniqueWallpapers[j]] = [uniqueWallpapers[j], uniqueWallpapers[i]];
    }

    // Return the top 30 wallpapers.
    return uniqueWallpapers.slice(0, 30);
  } catch (error) {
    console.error("Error in recommendWallpapersCustom:", error.message);
    return await getTrendingWallpapers();
  }
};

/**
 * Helper function: Enrich a wallpaper with uploader profile, like/save flags, and hashtags.
 * For each wallpaper:
 *  - Fetch uploader’s username, dp and id from the profiles table.
 *  - Check if the current user (passed as currentUserId) has liked the wallpaper.
 *  - Check if the current user has saved the wallpaper.
 *  - Fetch hashtags attached to the wallpaper.
 */
const enrichWallpaperDetails = async (wallpaper, currentUserId) => {
  // Uploader Profile (including profile id)
  const { data: profileData, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id, username, dp")
    .eq("user_id", wallpaper.user_id)
    .single();
  if (profileError) {
    console.error(`Error fetching profile for user ${wallpaper.user_id}:`, profileError.message);
    wallpaper.uploader_profile = null;
  } else {
    wallpaper.uploader_profile = profileData;
  }

  // Check if the current user has liked this wallpaper.
  const { data: likeData, error: likeError } = await supabaseAdmin
    .from("wallpaper_likes")
    .select("wallpaper_id")
    .eq("wallpaper_id", wallpaper.id)
    .eq("user_id", currentUserId)
    .single();
  wallpaper.isLiked = !!likeData;

  // Check if the current user has saved this wallpaper.
  const { data: savedData, error: savedError } = await supabaseAdmin
    .from("saved_wallpapers")
    .select("wallpaper_id")
    .eq("wallpaper_id", wallpaper.id)
    .eq("user_id", currentUserId)
    .single();
  wallpaper.isSaved = !!savedData;

  // Fetch attached hashtags (with the hashtag name).
  const { data: hashtagData, error: hashtagError } = await supabaseAdmin
    .from("wallpaper_hashtags")
    .select("hashtags(name)")
    .eq("wallpaper_id", wallpaper.id);
  if (hashtagError) {
    console.error(`Error fetching hashtags for wallpaper ${wallpaper.id}:`, hashtagError.message);
    wallpaper.hashtags = [];
  } else {
    wallpaper.hashtags = hashtagData.map((entry) => entry.hashtags.name);
  }

  return wallpaper;
};

/**
 * fetchForYou returns the 30 custom recommended wallpapers for the given user.
 * Each wallpaper is enriched with additional details (uploader profile, like/save status, hashtags).
 */
const fetchForYou = async (userId) => {
  try {
    console.log(`Fetching custom recommendations for user ${userId}...`);
    const recommendations = await recommendWallpapersCustom(userId);
    // Enrich each wallpaper before returning.
    const enrichedRecommendations = await Promise.all(
      recommendations.map(async (wallpaper) => {
        return await enrichWallpaperDetails(wallpaper, userId);
      })
    );
    console.log(`Returning ${enrichedRecommendations.length} recommendations for user ${userId}.`);
    return enrichedRecommendations;
  } catch (error) {
    console.error("Error in fetchForYou:", error.message);
    return [];
  }
};

/**
 * Express route for recommendations.
 */
router.get("/recommendations/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;
    console.log(`⚡ Generating custom wallpaper recommendations for user ${user_id}...`);
    const recommendations = await fetchForYou(user_id);
    res.status(200).json({ recommendations });
  } catch (err) {
    console.error("❌ Error in recommendation endpoint:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = {
  fetchForYou,
  router,
};
