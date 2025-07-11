// wallpaper.js

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid'); // Import UUID
const path = require('path');
const FormData = require('form-data');   // To submit form-data for our custom classifier.
const { createClient } = require('@supabase/supabase-js');
const { body, validationResult } = require('express-validator');

const router = express.Router();

// --- Environment Variable Checks ---
// Ensure all necessary environment variables are loaded for production.
// This is a good place to put simple checks.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("CRITICAL ERROR: SUPABASE_URL or SUPABASE_KEY is not set.");
  process.exit(1); // Exit if critical env vars are missing
}
if (!process.env.CUSTOM_MODEL_URL) {
  console.error("CRITICAL ERROR: CUSTOM_MODEL_URL is not set.");
  process.exit(1);
}
// Note: AZURE_ENDPOINT and AZURE_SUBSCRIPTION_KEY are no longer needed
// if Flask backend handles all moderation. Remove them from your .env if confirmed.

// Initialize Supabase client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false, // Important for server-side use
  },
});

// Define Flask Model Endpoints
const CUSTOM_CLASSIFY_URL = `${process.env.CUSTOM_MODEL_URL}/classify`;
const CUSTOM_MODERATE_URL = `${process.env.CUSTOM_MODEL_URL}/moderate`; // New moderation endpoint

// Setup Multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 } // Allow up to 16MB files
});

// Helper Function: Upload image to Supabase Storage.
const uploadImageToSupabase = async (buffer, newFileName) => {
  try {
    const filePath = `wallpapers/${newFileName}`;
    const { data, error } = await supabaseAdmin.storage
      .from('images') // Ensure your bucket name is "images"
      .upload(filePath, buffer, { cacheControl: '3600', upsert: false });
    if (error) {
      console.error('Supabase upload error:', error.message);
      throw new Error('Image upload failed: ' + error.message);
    }
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/images/${filePath}`;
    return publicUrl;
  } catch (err) {
    console.error('Error during image upload:', err.message);
    throw err;
  }
};

// Helper Function: Moderate the image using your custom Flask model.
// Expected response format:
// {"is_explicit": false, "flagged_categories": []}
const moderateImageWithCustomModel = async (imageBuffer, newFileName) => {
  try {
    const form = new FormData();
    form.append('image', imageBuffer, { filename: newFileName, contentType: 'image/jpeg' }); // Use appropriate content type
    const response = await axios.post(CUSTOM_MODERATE_URL, form, {
      headers: { ...form.getHeaders() }
    });
    return response.data; // Should contain is_explicit and flagged_categories
  } catch (err) {
    console.error('Error during custom model moderation:', err.message);
    // Log more details for debugging if it's an Axios error
    if (err.response) {
      console.error('Moderation API Response Data:', err.response.data);
      console.error('Moderation API Response Status:', err.response.status);
    }
    // If the moderation service is down or errors, we should mark for manual approval.
    return { is_explicit: true, flagged_categories: [{ category: 'moderation_service_error', confidence: 100 }] };
  }
};


// Helper Function: Classify the image using your custom model.
// Updated to expect new Flask response format.
// Expected response format: {"category": "...", "score": ..., "stage": "...", "styles": [{"label": "...", "score": ...}, ...]}
const classifyImageWithCustomModel = async (imageBuffer, newFileName) => {
  try {
    const form = new FormData();
    form.append('image', imageBuffer, { filename: newFileName, contentType: 'image/jpeg' }); // Use appropriate content type
    const response = await axios.post(CUSTOM_CLASSIFY_URL, form, {
      headers: { ...form.getHeaders() }
    });
    const data = response.data;

    // Extract category and styles from the new structure
    const category = data.category || null;
    let styles = [];
    if (Array.isArray(data.styles)) {
      // Extract just the labels from the styles array of objects
      styles = data.styles.map(s => s.label).slice(0, 5); // Ensure max 5 styles
    }

    return { category, styles };
  } catch (err) {
    console.error('Error during custom model classification:', err.message);
    // Log more details for debugging if it's an Axios error
    if (err.response) {
      console.error('Classification API Response Data:', err.response.data);
      console.error('Classification API Response Status:', err.response.status);
    }
    return { category: null, styles: [] }; // Return null category and empty styles on error
  }
};


// API Endpoint: Upload Wallpaper
// Route: /api/wallpaper/add
// Expects a multipart/form-data payload with:
// - image (file; required)
// - user_id (required)
// - title (required)
// - description (optional)
// - hashtags (optional; can be sent as array with field name "hashtags[]" or as comma-separated string)
router.post(
  '/add',
  upload.single('image'),
  [
    body('user_id').isString().trim().escape().notEmpty().withMessage('UserID is required.'),
    body('title')
      .isString()
      .trim()
      .escape()
      .notEmpty()
      .withMessage('Title is required.')
      .isLength({ max: 100 })
      .withMessage('Title must not exceed 100 characters.'),
    body('description')
      .optional({ checkFalsy: true })
      .isString()
      .trim()
      .escape()
      .isLength({ max: 500 })
      .withMessage('Description must not exceed 500 characters.'),
  ],
  async (req, res) => {
    try {
      // Validate incoming fields.
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      let { user_id, title, description, hashtags } = req.body;

      // Handle hashtags array if sent with "hashtags[]"
      if (!hashtags && req.body['hashtags[]']) {
        hashtags = req.body['hashtags[]'];
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Image file is required.' });
      }

      // Verify that the user exists.
      const { data: userData, error: userError } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('id', user_id)
        .single();
      if (userError || !userData) {
        console.error('User verification failed:', userError ? userError.message : 'User not found.');
        return res.status(404).json({ error: 'User not found.' });
      }

      // Generate a new filename using user_id and a random UUID (preserving the file extension).
      const extension = path.extname(req.file.originalname) || '';
      const newFileName = `${user_id}-${uuidv4()}${extension}`;

      // Step 1: Moderate the image first using your custom Flask model.
      const moderationResult = await moderateImageWithCustomModel(req.file.buffer, newFileName);
      let status = 'published';
      let moderationReason = '';

      if (moderationResult.is_explicit) {
        status = 'manual_approval';
        moderationReason = moderationResult.flagged_categories.map(fc => `${fc.category} (${fc.confidence.toFixed(2)}%)`).join(', ');
        console.warn(`Image flagged for manual approval due to explicit content: ${moderationReason}`);
      }

      // Step 2: Upload the image to Supabase Storage only if moderation passes (or if it's going to pending).
      // We upload regardless of initial moderation status because manual approval needs the image.
      const imageUrl = await uploadImageToSupabase(req.file.buffer, newFileName);

      // Step 3: Classify the image using your custom Flask model.
      const customClassifyResult = await classifyImageWithCustomModel(req.file.buffer, newFileName);
      const category = customClassifyResult.category;
      let styles = Array.isArray(customClassifyResult.styles)
        ? customClassifyResult.styles.slice(0, 5) // Ensure max 5 styles
        : [];

      if (!category) {
        console.warn('No category returned from custom model, marking for manual approval.');
        status = 'manual_approval'; // If classification fails, also require manual approval
      }

      // Decide the target table based on status.
      const targetTable = status === 'manual_approval' ? 'pending_wallpapers' : 'wallpapers';

      // Step 4: Insert the new wallpaper record.
      const { data: wallpaperData, error: wpError } = await supabaseAdmin
        .from(targetTable)
        .insert([{
          user_id,
          title,
          description,
          image_url: imageUrl,
          status,
          // Add a field for moderation reason if it's going to pending_wallpapers
          moderation_reason: status === 'manual_approval' ? moderationReason : null
        }])
        .select()
        .single();

      if (wpError) {
        console.error('Error inserting wallpaper record:', wpError.message);
        return res.status(500).json({ error: 'Error inserting wallpaper: ' + wpError.message });
      }

      // If the image was auto-approved (stored in "wallpapers"), process categories, styles, and hashtags.
      if (targetTable === 'wallpapers') {
        // Process category.
        if (category) {
          const standardizedCategory = category.toLowerCase().trim();
          const { data: catData, error: catError } = await supabaseAdmin
            .from('categories')
            .select('id')
            .eq('name', standardizedCategory)
            .single();
          let catId;
          if (catError || !catData) {
            // Category doesn't exist, insert it
            const { data: newCat, error: newCatError } = await supabaseAdmin
              .from('categories')
              .insert([{ name: standardizedCategory }])
              .select('id')
              .single();
            if (newCatError) {
              console.error(`Error creating new category "${standardizedCategory}":`, newCatError.message);
            } else if (newCat) {
              catId = newCat.id;
            }
          } else {
            catId = catData.id;
          }
          if (catId) {
            const { error: insertCatError } = await supabaseAdmin.from('wallpaper_categories').insert([{ wallpaper_id: wallpaperData.id, category_id: catId }]);
            if (insertCatError) {
              console.error(`Error linking wallpaper to category "${standardizedCategory}":`, insertCatError.message);
            }
          }
        }

        // Process styles.
        if (styles && styles.length > 0) {
          for (const styleName of styles) {
            const standardizedStyle = styleName.toLowerCase().trim();
            if (standardizedStyle === '') continue; // Skip empty style names

            const { data: styleData, error: styleError } = await supabaseAdmin
              .from('styles')
              .select('id')
              .eq('name', standardizedStyle)
              .single();
            let styleId;
            if (styleError || !styleData) {
              // Style doesn't exist, insert it
              const { data: newStyle, error: newStyleError } = await supabaseAdmin
                .from('styles')
                .insert([{ name: standardizedStyle }])
                .select('id')
                .single();
              if (newStyleError) {
                console.error(`Error creating new style "${standardizedStyle}":`, newStyleError.message);
              } else if (newStyle) {
                styleId = newStyle.id;
              }
            } else {
              styleId = styleData.id;
            }
            if (styleId) {
              const { error: insertStyleError } = await supabaseAdmin.from('wallpaper_styles').insert([{ wallpaper_id: wallpaperData.id, style_id: styleId }]);
              if (insertStyleError) {
                console.error(`Error linking wallpaper to style "${standardizedStyle}":`, insertStyleError.message);
              }
            }
          }
        }

        // Process hashtags.
        if (hashtags) {
          let tagList = [];
          if (typeof hashtags === 'string') {
            // If it's a string, split by comma
            tagList = hashtags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
          } else if (Array.isArray(hashtags)) {
            tagList = hashtags; // Use directly if it's already an array
          }

          for (const tag of tagList) {
            const standardizedTag = tag.toLowerCase().trim();
            if (standardizedTag === '') continue; // Skip empty tags

            const { data: tagData, error: tagError } = await supabaseAdmin
              .from('hashtags')
              .select('id')
              .eq('name', standardizedTag)
              .single();
            let hashtagId;
            if (tagError || !tagData) {
              // Hashtag doesn't exist, insert it
              const { data: newTag, error: newTagError } = await supabaseAdmin
                .from('hashtags')
                .insert([{ name: standardizedTag }])
                .select('id')
                .single();
              if (newTagError) {
                console.error(`Error creating hashtag "${standardizedTag}":`, newTagError.message);
                continue; // Continue to next tag if creation fails
              }
              hashtagId = newTag.id;
            } else {
              hashtagId = tagData.id;
            }
            const { error: insertHashtagError } = await supabaseAdmin.from('wallpaper_hashtags').insert([{ wallpaper_id: wallpaperData.id, hashtag_id: hashtagId }]);
            if (insertHashtagError) {
              console.error(`Error linking wallpaper to hashtag "${standardizedTag}":`, insertHashtagError.message);
            }
          }
        }
      }

      return res.status(201).json({ message: 'Wallpaper uploaded successfully!', wallpaper: wallpaperData });
    } catch (err) {
      console.error('Error in wallpaper upload:', err.message);
      // More detailed error response for debugging
      return res.status(500).json({ error: 'Internal server error: ' + err.message, stack: err.stack });
    }
  }
);

// API Endpoint: Delete Manual Wallpaper
// Route: /pending/:id (DELETE)
// Expects: 
//   - URL parameter: wallpaper ID
//   - Request body: { user_id: <requesting user's id> }
// Route: /pending/:id (DELETE)
// Expects:
//   - URL parameter: wallpaper ID
//   - Request body: { user_id: <requesting user's id> }
router.delete('/pending/:id', async (req, res) => {
  try {
    const wallpaperId = req.params.id;
    const { user_id: requestingUserId } = req.body; // Ensure this is sent in the request
    
    if (!wallpaperId || !requestingUserId) {
      return res.status(400).json({ error: 'Wallpaper ID and user_id are required.' });
    }
    
    // Fetch the pending wallpaper record.
    const { data: wallpaperData, error: fetchError } = await supabaseAdmin
      .from('pending_wallpapers')
      .select('*')
      .eq('id', wallpaperId)
      .single();
      
    if (fetchError || !wallpaperData) {
      return res.status(404).json({ error: 'Manual wallpaper not found.' });
    }
    
    // Check if the requesting user is authorized (the uploader).
    if (wallpaperData.user_id !== requestingUserId) {
      return res.status(403).json({ error: 'You are not authorized to delete this manual wallpaper.' });
    }
    
    // Extract the file path from the image URL.
    // For example, if imageUrl is:
    // "https://<project-ref>.supabase.co/storage/v1/object/public/images/wallpapers/filename.jpg"
    // then filePath should be: "wallpapers/filename.jpg"
    const imageUrl = wallpaperData.image_url;
    const parts = imageUrl.split('/storage/v1/object/public/images/');
    if (parts.length < 2 || !parts[1]) {
      return res.status(500).json({ error: 'Unable to derive file path from image URL.' });
    }
    let filePath = parts[1];
    // Remove a leading slash if present.
    if (filePath.startsWith('/')) {
      filePath = filePath.substring(1);
    }
    
    // Remove the image file from Supabase Storage.
    const { error: removeError } = await supabaseAdmin.storage
      .from('images')
      .remove([filePath]);
    
    // If the image file is not found (404), log a warning and continue.
    if (removeError) {
      if (removeError.status === 404) {
        console.warn('Image file not found in storage (404), proceeding with record deletion.');
      } else {
        console.error('Error deleting image file:', removeError.message);
        return res.status(500).json({ error: 'Failed to delete image file from storage.' });
      }
    }
    
    // Delete the pending wallpaper record.
    const { error: deleteError } = await supabaseAdmin
      .from('pending_wallpapers')
      .delete()
      .eq('id', wallpaperId);
      
    if (deleteError) {
      return res.status(500).json({ error: 'Failed to delete manual wallpaper record.' });
    }
    
    return res.status(200).json({ message: 'Manual wallpaper deleted successfully.' });
  } catch (err) {
    console.error('Error deleting manual wallpaper:', err.message);
    return res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});

// API Endpoint: Delete Wallpaper
// Route: /delete/:id
// Expects:
//   - URL parameter: wallpaper ID
//   - Request body: { user_id: <requesting user's id> }
// The endpoint checks that the wallpaper's user_id matches the requesting user_id before deletion.
router.delete('/delete/:id', async (req, res) => {
  try {
    const wallpaperId = req.params.id;
    const { user_id: requestingUserId } = req.body;  // Ensure you send this in the request
    
    if (!wallpaperId || !requestingUserId) {
      return res.status(400).json({ error: 'Wallpaper ID and user_id are required.' });
    }
    
    // Fetch the wallpaper record.
    const { data: wallpaperData, error: fetchError } = await supabaseAdmin
      .from('wallpapers')
      .select('*')
      .eq('id', wallpaperId)
      .single();
      
    if (fetchError || !wallpaperData) {
      return res.status(404).json({ error: 'Wallpaper not found.' });
    }
    
    // Check if the requesting user is the same as the uploader.
    if (wallpaperData.user_id !== requestingUserId) {
      return res.status(403).json({ error: 'You are not authorized to delete this wallpaper.' });
    }
    
    // Extract file path from the image URL.
    const imageUrl = wallpaperData.image_url;
    const parts = imageUrl.split('/storage/v1/object/public/images/');
    if (parts.length < 2) {
      return res.status(500).json({ error: 'Unable to derive file path from image URL.' });
    }
    const filePath = parts[1];
    
    // Remove the image file from Supabase Storage.
    const { error: removeError } = await supabaseAdmin.storage
      .from('images')
      .remove([filePath]);
    
    if (removeError) {
      console.error('Error deleting image file:', removeError.message);
      return res.status(500).json({ error: 'Failed to delete image file from storage.' });
    }
    
    // Delete the wallpaper record. Cascade deletion in your DB should take care of associated rows.
    const { error: deleteError } = await supabaseAdmin
      .from('wallpapers')
      .delete()
      .eq('id', wallpaperId);
      
    if (deleteError) {
      return res.status(500).json({ error: 'Failed to delete wallpaper record.' });
    }
    
    return res.status(200).json({ message: 'Wallpaper deleted successfully.' });
  } catch (err) {
    console.error('Error deleting wallpaper:', err.message);
    return res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});

// API Endpoint: Update Wallpaper Metrics
router.post("/update-metrics", async (req, res) => {
  try {
    const { wallpaper_id, metric, action, user_id } = req.body;
    if (!wallpaper_id || !metric || !user_id) {
      return res
        .status(400)
        .json({ error: "wallpaper_id, metric, and user_id are required." });
    }

    // For view, download, and share metrics:
    if (metric === "view" || metric === "download" || metric === "share") {
      let tableName, aggregateColumn;
      if (metric === "view") {
        tableName = "wallpaper_views";
        aggregateColumn = "view_count";
      } else if (metric === "download") {
        tableName = "wallpaper_downloads";
        aggregateColumn = "download_count";
      } else if (metric === "share") {
        tableName = "wallpaper_shares";
        aggregateColumn = "share_count";
      }

      // Try to fetch an existing event record
      const { data: existingEvent, error: fetchEventError } =
        await supabaseAdmin
          .from(tableName)
          .select("*")
          .eq("wallpaper_id", wallpaper_id)
          .eq("user_id", user_id)
          .single();

      if (fetchEventError && fetchEventError.code !== 'PGRST116') {
        return res.status(500).json({
          error: `Error fetching existing ${metric} event: ${fetchEventError.message}`,
        });
      }

      // If the user has already engaged, increment the count
      if (existingEvent) {
        const { error: updateCountError } = await supabaseAdmin
          .from(tableName)
          .update({
            count: existingEvent.count + 1,
            created_at: new Date().toISOString(), // Optional: update timestamp if desired
          })
          .eq("id", existingEvent.id);
        if (updateCountError) {
          return res.status(500).json({
            error: `Failed to update ${metric} count: ${updateCountError.message}`,
          });
        }
      } else {
        // No existing record: insert a new one with count = 1.
        const { error: insertError } = await supabaseAdmin
          .from(tableName)
          .insert([{ wallpaper_id, user_id, count: 1 }]);
        if (insertError) {
          return res.status(500).json({
            error: `Failed to log ${metric} event: ${insertError.message}`,
          });
        }
      }

      // Update aggregate count in the wallpapers table.
      const { data: wp, error: fetchError } = await supabaseAdmin
        .from("wallpapers")
        .select(aggregateColumn)
        .eq("id", wallpaper_id)
        .single();
      if (fetchError) {
        return res
          .status(500)
          .json({ error: "Error fetching wallpaper info." });
      }
      const currentCount = wp[aggregateColumn] || 0;
      const newCount = currentCount + 1;

      const { error: updateError } = await supabaseAdmin
        .from("wallpapers")
        .update({ [aggregateColumn]: newCount })
        .eq("id", wallpaper_id);
      if (updateError) {
        return res.status(500).json({
          error: `Error updating ${metric} count: ${updateError.message}`,
        });
      }
      return res.status(200).json({
        message: `${metric} event recorded successfully.`,
        newCount,
      });
    }
    // The like metric handling remains unchanged.
    else if (metric === "like") {
      if (!action) {
        return res
          .status(400)
          .json({ error: "action is required for like metric." });
      }

      if (action === "add") {
        // Check if the user already liked the wallpaper.
        const { data: existingLike } = await supabaseAdmin
          .from("wallpaper_likes")
          .select("*")
          .eq("wallpaper_id", wallpaper_id)
          .eq("user_id", user_id)
          .single();
        if (existingLike) {
          return res
            .status(400)
            .json({ error: "User already liked this wallpaper." });
        }
        // Insert a new like record.
        const { error: insertError } = await supabaseAdmin
          .from("wallpaper_likes")
          .insert([{ wallpaper_id, user_id }]);
        if (insertError) {
          return res.status(500).json({
            error: "Error adding like record: " + insertError.message,
          });
        }
        // Increment the like_count.
        const { data: wp, error: fetchError } = await supabaseAdmin
          .from("wallpapers")
          .select("like_count")
          .eq("id", wallpaper_id)
          .single();
        const currentCount = wp.like_count || 0;
        const newCount = currentCount + 1;
        const { error: updateError } = await supabaseAdmin
          .from("wallpapers")
          .update({ like_count: newCount })
          .eq("id", wallpaper_id);
        if (updateError) {
          return res.status(500).json({
            error: "Error updating like count: " + updateError.message,
          });
        }
        return res
          .status(200)
          .json({ message: "Like added successfully.", newCount });
      } else if (action === "remove") {
        // Delete the like record.
        const { error: deleteError } = await supabaseAdmin
          .from("wallpaper_likes")
          .delete()
          .eq("wallpaper_id", wallpaper_id)
          .eq("user_id", user_id);
        if (deleteError) {
          return res.status(500).json({
            error: "Error removing like record: " + deleteError.message,
          });
        }
        // Decrement the like_count.
        const { data: wp, error: fetchError } = await supabaseAdmin
          .from("wallpapers")
          .select("like_count")
          .eq("id", wallpaper_id)
          .single();
        const currentCount = wp.like_count || 0;
        const newCount = currentCount > 0 ? currentCount - 1 : 0;
        const { error: updateError } = await supabaseAdmin
          .from("wallpapers")
          .update({ like_count: newCount })
          .eq("id", wallpaper_id);
        if (updateError) {
          return res.status(500).json({
            error: "Error updating like count: " + updateError.message,
          });
        }
        return res
          .status(200)
          .json({ message: "Like removed successfully.", newCount });
      } else {
        return res
          .status(400)
          .json({ error: "Invalid action for like metric." });
      }
    } else {
      return res.status(400).json({ error: "Invalid metric type." });
    }
  } catch (err) {
    console.error("Error updating metrics:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
