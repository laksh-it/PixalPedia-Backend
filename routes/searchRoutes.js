const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../supabaseClient");

// ----------------------------------------------------------------------------
// Helper: Get unique 3-letter chunks (trigrams) from a string.
const getTrigrams = (str) => {
  const trigrams = new Set();
  const clean = str.trim().toLowerCase();
  for (let i = 0; i <= clean.length - 3; i++) {
    trigrams.add(clean.substr(i, 3));
  }
  return Array.from(trigrams);
};

// ----------------------------------------------------------------------------
// Helper: Enrich a wallpaper with uploader profile, like/save flags, and hashtags.
// Now, we also query for and attach the uploader's profile (id, username and dp).
const enrichWallpaperDetails = async (wallpaper, currentUserId) => {
  // Fetch uploader profile: id, username, and dp.
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
    wallpaper.hashtags = hashtagData.map((item) => item.hashtags.name);
  }

  return wallpaper;
};

// ----------------------------------------------------------------------------
// Helper: Enrich an array of wallpapers.
const enrichWallpapers = async (wallpapers, currentUserId) => {
  return await Promise.all(
    wallpapers.map(async (wp) => await enrichWallpaperDetails(wp, currentUserId))
  );
};

// ----------------------------------------------------------------------------
// Main smart search function.
// • Searches wallpapers by title, categories, hashtags and styles using trigrams.
// • Each source has a weight: higher weight means a better match.
// • Results from all sources are merged (summing scores for duplicate wallpaper IDs),
//   then sorted and paginated by 30 wallpapers per page (refresh=0 means first 30,
//   refresh=1 the next 30, etc.).
// • If no matches are found, random wallpapers are returned.
// Now, each wallpaper is subsequently enriched with uploader details, like/save flags, and hashtags.
const smartSearchWallpapers = async (query, refreshCount = 0, currentUserId) => {
  const trimmed = query.trim();
  if (trimmed.length < 3) {
    return {
      fallback: true,
      message: "Please enter at least 3 letters.",
      wallpapers: [],
    };
  }

  // Get all unique 3-letter segments.
  const trigrams = getTrigrams(trimmed);

  // Result map keyed by wallpaper ID.
  let results = {};

  // Define weights.
  const weights = {
    title: 1,
    category: 3,
    hashtag: 2,
    style: 3,
  };

  // ---------------------- Title search ----------------------
  for (const tri of trigrams) {
    const { data, error } = await supabaseAdmin
      .from("wallpapers")
      .select("*")
      .ilike("title", `%${tri}%`);
    if (error) {
      console.error("Title search error:", error.message);
    } else if (data && data.length) {
      data.forEach((wp) => {
        if (!results[wp.id]) {
          results[wp.id] = { wallpaper: wp, score: 0 };
        }
        results[wp.id].score += weights.title;
      });
    }
  }

  // ---------------------- Category search ----------------------
  for (const tri of trigrams) {
    const { data: categories, error: catError } = await supabaseAdmin
      .from("categories")
      .select("id, name")
      .ilike("name", `%${tri}%`);
    if (catError) {
      console.error("Category search error:", catError.message);
    } else if (categories && categories.length) {
      const categoryIds = categories.map((cat) => cat.id);
      // Lookup wallpapers that belong to these categories.
      const { data: wcData, error: wcError } = await supabaseAdmin
        .from("wallpaper_categories")
        .select("wallpaper_id")
        .in("category_id", categoryIds);
      if (wcError) {
        console.error("Wallpaper_categories query error:", wcError.message);
      } else if (wcData && wcData.length) {
        for (const item of wcData) {
          const wallpaperId = item.wallpaper_id;
          if (!results[wallpaperId]) {
            const { data: wpData, error: wpError } = await supabaseAdmin
              .from("wallpapers")
              .select("*")
              .eq("id", wallpaperId)
              .single();
            if (wpError) {
              console.error("Fetching wallpaper error:", wpError.message);
              continue;
            }
            results[wallpaperId] = { wallpaper: wpData, score: 0 };
          }
          results[wallpaperId].score += weights.category;
        }
      }
    }
  }

  // ---------------------- Hashtag search ----------------------
  for (const tri of trigrams) {
    const { data: hashtags, error: tagError } = await supabaseAdmin
      .from("hashtags")
      .select("id, name")
      .ilike("name", `%${tri}%`);
    if (tagError) {
      console.error("Hashtag search error:", tagError.message);
    } else if (hashtags && hashtags.length) {
      const hashtagIds = hashtags.map((tag) => tag.id);
      const { data: whData, error: whError } = await supabaseAdmin
        .from("wallpaper_hashtags")
        .select("wallpaper_id")
        .in("hashtag_id", hashtagIds);
      if (whError) {
        console.error("Wallpaper_hashtags query error:", whError.message);
      } else if (whData && whData.length) {
        for (const item of whData) {
          const wallpaperId = item.wallpaper_id;
          if (!results[wallpaperId]) {
            const { data: wpData, error: wpError } = await supabaseAdmin
              .from("wallpapers")
              .select("*")
              .eq("id", wallpaperId)
              .single();
            if (wpError) {
              console.error("Fetching wallpaper error:", wpError.message);
              continue;
            }
            results[wallpaperId] = { wallpaper: wpData, score: 0 };
          }
          results[wallpaperId].score += weights.hashtag;
        }
      }
    }
  }

  // ---------------------- Style search ----------------------
  for (const tri of trigrams) {
    const { data: styles, error: styleError } = await supabaseAdmin
      .from("styles")
      .select("id, name")
      .ilike("name", `%${tri}%`);
    if (styleError) {
      console.error("Style search error:", styleError.message);
    } else if (styles && styles.length) {
      const styleIds = styles.map((s) => s.id);
      const { data: wsData, error: wsError } = await supabaseAdmin
        .from("wallpaper_styles")
        .select("wallpaper_id")
        .in("style_id", styleIds);
      if (wsError) {
        console.error("Wallpaper_styles query error:", wsError.message);
      } else if (wsData && wsData.length) {
        for (const item of wsData) {
          const wallpaperId = item.wallpaper_id;
          if (!results[wallpaperId]) {
            const { data: wpData, error: wpError } = await supabaseAdmin
              .from("wallpapers")
              .select("*")
              .eq("id", wallpaperId)
              .single();
            if (wpError) {
              console.error("Fetching wallpaper error:", wpError.message);
              continue;
            }
            results[wallpaperId] = { wallpaper: wpData, score: 0 };
          }
          results[wallpaperId].score += weights.style;
        }
      }
    }
  }

  // ---------------------- Merge and sort results ----------------------
  let resultArray = Object.values(results);
  resultArray.sort((a, b) => {
    if (b.score === a.score) {
      return new Date(b.wallpaper.created_at) - new Date(a.wallpaper.created_at);
    }
    return b.score - a.score;
  });

  // ---------------------- Fallback: Use random wallpapers if nothing matched ----------------------
  if (resultArray.length === 0) {
    const { data: randomData, error: randomError } = await supabaseAdmin
      .from("wallpapers")
      .select("*");
    if (randomError) {
      console.error("Random wallpaper query error:", randomError.message);
    } else if (randomData && randomData.length) {
      // Simple shuffle.
      for (let i = randomData.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [randomData[i], randomData[j]] = [randomData[j], randomData[i]];
      }
      resultArray = randomData.map((wp) => ({ wallpaper: wp, score: 0 }));
      // Paginate and enrich the random results.
      const paginatedRandom = resultArray
        .slice(refreshCount * 30, refreshCount * 30 + 30)
        .map((item) => item.wallpaper);
      const enrichedRandom = await enrichWallpapers(paginatedRandom, currentUserId);
      return {
        fallback: true,
        message: "No match found. Showing random wallpapers.",
        wallpapers: enrichedRandom,
      };
    }
  }

  // ---------------------- Pagination and enrichment ----------------------
  const pageSize = 30;
  const startIndex = refreshCount * pageSize;
  const paginated = resultArray
    .slice(startIndex, startIndex + pageSize)
    .map((item) => item.wallpaper);
  if (paginated.length === 0) {
    return { fallback: true, message: "No more wallpapers found for this search.", wallpapers: [] };
  }
  const enrichedPaginated = await enrichWallpapers(paginated, currentUserId);
  return { fallback: false, wallpapers: enrichedPaginated };
};

// ----------------------------------------------------------------------------
// GET /search Endpoint
// Query parameters:
//    q       - the search query (required)
//    refresh - page number (0 for first 30, 1 for next 30, etc.)
//    user_id - current user's id (for like/save enrichment)
// Usage example: 
//   http://localhost:3000/api/search?q=car&refresh=0&user_id=YOUR_USER_ID
router.get("/search", async (req, res) => {
  try {
    const { q, refresh, user_id } = req.query;
    if (!q) {
      return res.status(400).json({ error: "Missing required query parameter 'q'" });
    }
    // We assume user_id is provided to know the current user's context.
    const refreshCount = refresh ? parseInt(refresh, 10) : 0;
    const result = await smartSearchWallpapers(q, refreshCount, user_id);
    return res.status(200).json(result);
  } catch (err) {
    console.error("Error in search endpoint:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
