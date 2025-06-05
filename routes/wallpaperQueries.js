const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../supabaseClient"); // Adjust the path as needed

/**
 * Fetch trending wallpapers based on view_count (desc).
 * Returns up to 30 wallpapers with the highest view counts.
 */
const fetchTrendingWallpapers = async () => {
  try {
    console.log("Fetching trending wallpapers (sorted by view_count desc)...");
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
    console.error("Error in fetchTrendingWallpapers:", err.message);
    return [];
  }
};

/**
 * Fetch latest wallpapers based on created_at (desc).
 * Returns up to 30 wallpapers that were most recently created.
 */
const fetchLatestWallpapers = async () => {
  try {
    console.log("Fetching latest wallpapers (sorted by created_at desc)...");
    const { data, error } = await supabaseAdmin
      .from("wallpapers")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) {
      console.error("Error fetching latest wallpapers:", error.message);
      return [];
    }
    return data;
  } catch (err) {
    console.error("Error in fetchLatestWallpapers:", err.message);
    return [];
  }
};

/**
 * Helper: Enrich a wallpaper object with uploader profile, like/save flags, hashtags and styles.
 * The uploader profile includes: id, username, and dp.
 * The function uses the provided currentUserId (obtained from the URL) to check whether
 * the wallpaper has been liked or saved by the current user.
 */
const enrichWallpaperDetails = async (wallpaper, currentUserId) => {
  // Fetch uploader profile: id, username, and dp.
  const { data: profileData, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id, username, dp")
    .eq("user_id", wallpaper.user_id)
    .single();
  wallpaper.uploader_profile = profileError ? null : profileData;

  // Check if current user has liked this wallpaper.
  const { data: likeData } = await supabaseAdmin
    .from("wallpaper_likes")
    .select("wallpaper_id")
    .eq("wallpaper_id", wallpaper.id)
    .eq("user_id", currentUserId)
    .maybeSingle();
  wallpaper.isLiked = !!likeData;

  // Check if current user has saved this wallpaper.
  const { data: savedData } = await supabaseAdmin
    .from("saved_wallpapers")
    .select("wallpaper_id")
    .eq("wallpaper_id", wallpaper.id)
    .eq("user_id", currentUserId)
    .maybeSingle();
  wallpaper.isSaved = !!savedData;

  // Fetch attached hashtags (with hashtag name).
  const { data: hashtagData, error: hashtagError } = await supabaseAdmin
    .from("wallpaper_hashtags")
    .select("hashtags(name)")
    .eq("wallpaper_id", wallpaper.id);
  wallpaper.hashtags = hashtagError
    ? []
    : hashtagData.map(entry => entry.hashtags.name);

  // (Optionally) Fetch attached styles.
  const { data: styleData, error: styleError } = await supabaseAdmin
    .from("wallpaper_styles")
    .select("styles(*)")
    .eq("wallpaper_id", wallpaper.id);
  wallpaper.styles = styleError
    ? []
    : styleData.map(entry => entry.styles);

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

// ----------------------------------------------------------------------------
// Trending Wallpapers Endpoint
// Route: GET /wallpapers/trending/:user_id
// Returns an array of trending wallpaper objects enriched with uploader details,
// like/save flags for the current user, and hashtags.
router.get("/wallpapers/trending/:user_id", async (req, res) => {
  try {
    // Extract the current user's id from the URL route parameter
    const currentUserId = req.params.user_id;
    const wallpapers = await fetchTrendingWallpapers();
    const enrichedWallpapers = await enrichWallpapers(wallpapers, currentUserId);
    res.status(200).json({ wallpapers: enrichedWallpapers });
  } catch (err) {
    console.error("Error in trending wallpapers endpoint:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ----------------------------------------------------------------------------
// Latest Wallpapers Endpoint
// Route: GET /wallpapers/latest/:user_id
// Returns an array of latest wallpaper objects enriched with uploader details,
// like/save flags for the current user, and hashtags.
router.get("/wallpapers/latest/:user_id", async (req, res) => {
  try {
    // Extract the current user's id from the URL route parameter
    const currentUserId = req.params.user_id;
    const wallpapers = await fetchLatestWallpapers();
    const enrichedWallpapers = await enrichWallpapers(wallpapers, currentUserId);
    res.status(200).json({ wallpapers: enrichedWallpapers });
  } catch (err) {
    console.error("Error in latest wallpapers endpoint:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
