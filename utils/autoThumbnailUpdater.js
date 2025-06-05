// autoThumbnailUpdater.js
const { supabaseAdmin } = require('../supabaseClient'); // adjust the path as needed

// Function that creates thumbnails for categories missing them.
const updateMissingCategoryThumbnails = async () => {
  try {
    console.log(">> [Missing Thumbnail Updater] Running: Checking for categories missing thumbnails...");

    // First, fetch all category IDs that already have a thumbnail.
    const { data: thumbData, error: thumbError } = await supabaseAdmin
      .from("category_thumbnails")
      .select("category_id");

    if (thumbError) {
      console.error("Error fetching existing thumbnails:", thumbError.message);
      return;
    }

    // Build an array of category IDs that already have thumbnails.
    const thumbCategoryIds = thumbData.map(item => item.category_id) || [];

    // Next, fetch all categories.
    const { data: allCategories, error: allCatError } = await supabaseAdmin
      .from("categories")
      .select("id");

    if (allCatError) {
      console.error("Error fetching all categories:", allCatError.message);
      return;
    }

    // Filter out categories that already have thumbnails.
    const missingCategories = allCategories.filter(cat => !thumbCategoryIds.includes(cat.id));

    // Loop through each missing category.
    for (const category of missingCategories) {
      // For the given category, fetch one random wallpaper's image URL via the junction table.
      const { data: wcData, error: wpError } = await supabaseAdmin
        .from("wallpaper_categories")
        .select("wallpapers(image_url)")
        .eq("category_id", category.id);

      if (wpError) {
        console.error(`Error fetching wallpapers for category ${category.id}:`, wpError.message);
        continue;
      }

      if (wcData && wcData.length > 0) {
        // Pick a random wallpaper from the results.
        const randomIndex = Math.floor(Math.random() * wcData.length);
        const imageUrl = wcData[randomIndex].wallpapers.image_url;
        if (!imageUrl) {
          console.warn(`No image URL found for category ${category.id}`);
          continue;
        }

        // Insert a new record in category_thumbnails with the chosen wallpaper's URL.
        const { error: insertError } = await supabaseAdmin
          .from("category_thumbnails")
          .insert([{ category_id: category.id, thumbnail_url: imageUrl }]);

        if (insertError) {
          console.error(`Error inserting thumbnail for category ${category.id}:`, insertError.message);
        } else {
          console.log(`Inserted thumbnail for category ${category.id}`);
        }
      } else {
        console.log(`No wallpapers found for category ${category.id}`);
      }
    }
  } catch (err) {
    console.error("Error in updateMissingCategoryThumbnails:", err.message);
  }
};

// Function that updates all category thumbnails randomly.
const updateAllCategoryThumbnailsRandomly = async () => {
  try {
    console.log(">> [Full Thumbnail Refresh] Running: Refreshing thumbnails for ALL categories...");

    // Get all categories.
    const { data: categories, error: catError } = await supabaseAdmin
      .from("categories")
      .select("id");

    if (catError) {
      console.error("Error fetching all categories:", catError.message);
      return;
    }

    // Loop through each category to update its thumbnail.
    for (const category of categories) {
      // Fetch wallpapers for the category.
      const { data: wcData, error: wpError } = await supabaseAdmin
        .from("wallpaper_categories")
        .select("wallpapers(image_url)")
        .eq("category_id", category.id);

      if (wpError) {
        console.error(`Error fetching wallpapers for category ${category.id}:`, wpError.message);
        continue;
      }

      if (wcData && wcData.length > 0) {
        // Choose a random wallpaper.
        const randomIndex = Math.floor(Math.random() * wcData.length);
        const imageUrl = wcData[randomIndex].wallpapers.image_url;
        if (!imageUrl) {
          console.warn(`No image URL found for category ${category.id}`);
          continue;
        }

        // Use upsert to update or insert the thumbnail record.
        const { error: updateError } = await supabaseAdmin
          .from("category_thumbnails")
          .upsert([{ category_id: category.id, thumbnail_url: imageUrl }]);
        if (updateError) {
          console.error(`Error updating thumbnail for category ${category.id}:`, updateError.message);
        } else {
          console.log(`Updated thumbnail for category ${category.id}`);
        }
      } else {
        console.log(`No wallpapers found for category ${category.id}`);
      }
    }
  } catch (err) {
    console.error("Error in updateAllCategoryThumbnailsRandomly:", err.message);
  }
};

// Trigger the missing thumbnail updater at server startup.
console.log("AutoThumbnailUpdater: Starting missing thumbnails update on startup.");
updateMissingCategoryThumbnails();

// Schedule updateMissingCategoryThumbnails every 15 minutes.
setInterval(() => {
  console.log("AutoThumbnailUpdater: Running scheduled missing thumbnails update.");
  updateMissingCategoryThumbnails();
}, 15 * 60 * 1000);

// Schedule updateAllCategoryThumbnailsRandomly every 15 days.
setInterval(() => {
  console.log("AutoThumbnailUpdater: Running scheduled full thumbnail refresh (all categories).");
  updateAllCategoryThumbnailsRandomly();
}, 15 * 24 * 60 * 60 * 1000);

console.log("AutoThumbnailUpdater: Scheduler set up successfully.");

module.exports = { updateMissingCategoryThumbnails, updateAllCategoryThumbnailsRandomly };
