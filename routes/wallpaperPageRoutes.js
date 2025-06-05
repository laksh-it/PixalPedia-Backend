const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../supabaseClient"); // Adjust the path as needed

/**
 * Helper: Enriches a wallpaper object with uploader profile (id, username and dp),
 * like/save flags (for the current user) and attached hashtags and styles.
 */
const enrichWallpaperDetails = async (wallpaper, currentUserId) => {
  // Fetch uploader profile: id, username and display picture (dp)
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

  // Fetch attached hashtags (with the hashtag name).
  const { data: hashtagData, error: hashtagError } = await supabaseAdmin
    .from("wallpaper_hashtags")
    .select("hashtags(name)")
    .eq("wallpaper_id", wallpaper.id);
  wallpaper.hashtags = hashtagError ? [] : hashtagData.map(entry => entry.hashtags.name);

  // Fetch attached styles (using the junction table and join).
  const { data: styleData, error: styleError } = await supabaseAdmin
    .from("wallpaper_styles")
    .select("styles(*)")
    .eq("wallpaper_id", wallpaper.id);
  wallpaper.styles = styleError ? [] : styleData.map(entry => entry.styles);

  return wallpaper;
};

/**
 * GET /wallpapers/:id/:user_id
 * Returns detailed info for a single wallpaper plus recommends up to 9 related wallpapers.
 * The endpoint expects the current user's id as a route parameter.
 */
router.get("/wallpapers/:id/:user_id", async (req, res) => {
  try {
    const wallpaperId = req.params.id;
    // Get current user's id from the URL parameter.
    const currentUserId = req.params.user_id;

    // --- 1. Fetch the main wallpaper details.
    const { data: wallpaperData, error: mainErr } = await supabaseAdmin
      .from("wallpapers")
      .select("*")
      .eq("id", wallpaperId)
      .single();

    if (mainErr) {
      console.error("Error fetching wallpaper:", mainErr.message);
      return res.status(500).json({ error: "Error fetching wallpaper data." });
    }
    if (!wallpaperData) {
      return res.status(404).json({ error: "Wallpaper not found." });
    }

    // Enrich the main wallpaper with uploader details, like/save flags, hashtags, and styles.
    const enrichedMain = await enrichWallpaperDetails(wallpaperData, currentUserId);

    // --- 2. Fetch related recommendation candidates.
    // Fetch associated hashtags for the main wallpaper.
    const { data: wallpaperHashtags } = await supabaseAdmin
      .from("wallpaper_hashtags")
      .select("hashtag_id")
      .eq("wallpaper_id", wallpaperId);
    const hashtagIds = wallpaperHashtags ? wallpaperHashtags.map(entry => entry.hashtag_id) : [];

    // Fetch associated categories.
    const { data: wallpaperCategories } = await supabaseAdmin
      .from("wallpaper_categories")
      .select("category_id")
      .eq("wallpaper_id", wallpaperId);
    const categoryIds = wallpaperCategories ? wallpaperCategories.map(entry => entry.category_id) : [];

    // 5.1. Wallpapers posted by the same user (excluding the main wallpaper).
    const { data: sameUserWallpapers, error: sameUserErr } = await supabaseAdmin
      .from("wallpapers")
      .select("*")
      .eq("user_id", wallpaperData.user_id)
      .neq("id", wallpaperId);
    if (sameUserErr) {
      console.error("Error fetching same-user wallpapers:", sameUserErr.message);
    }

    // 5.2. Wallpapers sharing at least one hashtag with the main wallpaper.
    let candidateByHashtags = [];
    if (hashtagIds.length > 0) {
      const { data: hashtagCandidates, error: hashCandidatesErr } = await supabaseAdmin
        .from("wallpaper_hashtags")
        .select("wallpaper_id")
        .in("hashtag_id", hashtagIds)
        .neq("wallpaper_id", wallpaperId);
      if (hashCandidatesErr) {
        console.error("Error fetching hashtag candidates:", hashCandidatesErr.message);
      } else if (hashtagCandidates && hashtagCandidates.length > 0) {
        const uniqueHashtagWpIds = Array.from(new Set(hashtagCandidates.map(item => item.wallpaper_id)));
        const { data: wallpapersByHashtag, error: wpByHashErr } = await supabaseAdmin
          .from("wallpapers")
          .select("*")
          .in("id", uniqueHashtagWpIds);
        if (wpByHashErr) {
          console.error("Error fetching wallpapers by hashtag:", wpByHashErr.message);
        } else {
          candidateByHashtags = wallpapersByHashtag || [];
        }
      }
    }

    // 5.3. Wallpapers in the same categories.
    let candidateByCategories = [];
    if (categoryIds.length > 0) {
      const { data: categoryCandidates, error: catCandidatesErr } = await supabaseAdmin
        .from("wallpaper_categories")
        .select("wallpaper_id")
        .in("category_id", categoryIds)
        .neq("wallpaper_id", wallpaperId);
      if (catCandidatesErr) {
        console.error("Error fetching category candidates:", catCandidatesErr.message);
      } else if (categoryCandidates && categoryCandidates.length > 0) {
        const uniqueCategoryWpIds = Array.from(new Set(categoryCandidates.map(item => item.wallpaper_id)));
        const { data: wallpapersByCategory, error: wpByCatErr } = await supabaseAdmin
          .from("wallpapers")
          .select("*")
          .in("id", uniqueCategoryWpIds);
        if (wpByCatErr) {
          console.error("Error fetching wallpapers by category:", wpByCatErr.message);
        } else {
          candidateByCategories = wallpapersByCategory || [];
        }
      }
    }

    // 5.4. Combine all candidate recommendations into one set (removing duplicates).
    let candidateMap = {};
    if (sameUserWallpapers) {
      sameUserWallpapers.forEach(wp => candidateMap[wp.id] = wp);
    }
    if (candidateByHashtags) {
      candidateByHashtags.forEach(wp => candidateMap[wp.id] = wp);
    }
    if (candidateByCategories) {
      candidateByCategories.forEach(wp => candidateMap[wp.id] = wp);
    }
    // Ensure the main wallpaper is not included.
    delete candidateMap[wallpaperId];

    let candidates = Object.values(candidateMap);

    // Utility: Shuffle candidates using Fisher–Yates.
    const shuffleArray = (array) => {
      for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
      }
      return array;
    };
    candidates = shuffleArray(candidates);

    // Take up to 9 recommendations.
    const recommendations = candidates.slice(0, 9);

    // Enrich each recommendation candidate.
    const enrichedRecommendations = await Promise.all(
      recommendations.map(async (wp) => await enrichWallpaperDetails(wp, currentUserId))
    );

    // --- 6. Build and send the response.
    const responseObj = {
      wallpaper: enrichedMain,
      recommendations: enrichedRecommendations
    };

    res.status(200).json(responseObj);

  } catch (err) {
    console.error("Error fetching wallpaper page data:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
