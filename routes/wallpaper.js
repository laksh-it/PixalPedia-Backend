// wallpaper.js

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');
const { body, validationResult } = require('express-validator');

const router = express.Router();

// Initialize Supabase client (ensure environment variables are set)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_KEY);

// Read the custom model URLs from the environment variables.
const CUSTOM_CLASSIFY_MODEL_URL = process.env.CUSTOM_CLASSIFY_MODEL_URL;
const CUSTOM_MODERATE_MODEL_URL = process.env.CUSTOM_MODERATE_MODEL_URL;

// Setup Multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 } // Allow up to 16MB files
});

// Helper Function: Upload image to Supabase Storage without compressing it.
const uploadImageToSupabase = async (buffer, newFileName) => {
  try {
    const filePath = `wallpapers/${newFileName}`;
    const { data, error } = await supabaseAdmin.storage
      .from('images') // Ensure your bucket name is "images"
      .upload(filePath, buffer, { cacheControl: '3600', upsert: false });
    if (error) {
      console.error('Supabase upload error:', error.message);
      throw new Error('Image upload failed.');
    }
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/images/${filePath}`;
    return publicUrl;
  } catch (err) {
    console.error('Error during image upload:', err.message);
    throw err;
  }
};

// Helper Function: Moderate image with your custom CLIP model.
const moderateImageWithCustomModel = async (imageBuffer, newFileName) => {
  try {
    if (!CUSTOM_MODERATE_MODEL_URL) {
      console.warn('CUSTOM_MODERATE_MODEL_URL is not set. Skipping custom moderation.');
      return { approved: true, reason: "Custom moderation URL not configured." };
    }

    const form = new FormData();
    form.append('image', imageBuffer, { filename: newFileName, contentType: 'application/octet-stream' });

    const response = await axios.post(CUSTOM_MODERATE_MODEL_URL, form, {
      headers: { ...form.getHeaders() }
    });

    const result = response.data;
    if (result && result.is_explicit) {
      const flaggedCategories = result.flagged_categories.map(fc => `${fc.category} (${fc.confidence.toFixed(2)}%)`).join(', ');
      return { approved: false, reason: `Image flagged by custom moderation: ${flaggedCategories}` };
    }
    return { approved: true };
  } catch (err) {
    console.error('Error during custom model moderation:', err.message);
    if (err.response) {
      console.error('Custom moderation API response error:', err.response.data);
      return { approved: false, reason: `Custom moderation failed: ${err.response.data.error || err.message}` };
    }
    return { approved: false, reason: `Custom moderation failed: ${err.message}` };
  }
};

// Helper Function: Classify the image using your custom model.
const classifyImageWithCustomModel = async (imageBuffer, newFileName) => {
  try {
    if (!CUSTOM_CLASSIFY_MODEL_URL) {
      console.warn('CUSTOM_CLASSIFY_MODEL_URL is not set. Skipping custom classification.');
      return { category: null, styles: [] };
    }

    const form = new FormData();
    form.append('image', imageBuffer, { filename: newFileName, contentType: 'application/octet-stream' });

    const response = await axios.post(CUSTOM_CLASSIFY_MODEL_URL, form, {
      headers: { ...form.getHeaders() }
    });
    const data = response.data;

    let category = data.category || null; // Ensure 'category' is used, fallback to null
    let rawStyles = data.styles || []; // Get the raw array of style objects

    // --- FIX START: Extract 'label' from each style object ---
    let styles = [];
    if (Array.isArray(rawStyles)) {
        styles = rawStyles
            .map(item => typeof item.label === 'string' ? item.label : null) // Extract 'label' if it's a string, otherwise null
            .filter(item => item !== null) // Remove any null entries
            .slice(0, 5); // Take at most 5 styles
    }
    // --- FIX END ---

    return { category: category, styles: styles };
  } catch (err) {
    console.error('Error during custom model classification:', err.message);
    if (err.response) {
      console.error('Custom classification API response error:', err.response.data);
    }
    return { category: null, styles: [] };
  }
};

// API Endpoint: Upload Wallpaper
// Route: /api/wallpaper/add
router.post(
  '/add',
  upload.single('image'),
  [
    body('user_id').isString().trim().escape().notEmpty().withMessage('UserID is required.'),
    body('title')
      .isString()
      .trim()
      .escape()
      .notEmpty().withMessage('Title is required.')
      .isLength({ max: 100 }).withMessage('Title must not exceed 100 characters.'),
    body('description')
      .optional({ checkFalsy: true })
      .isString()
      .trim()
      .escape()
      .isLength({ max: 500 }).withMessage('Description must not exceed 500 characters.'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      let { user_id, title, description, hashtags } = req.body;

      if (!hashtags && req.body['hashtags[]']) {
        hashtags = req.body['hashtags[]'];
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Image file is required.' });
      }

      const { data: userData, error: userError } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('id', user_id)
        .single();
      if (userError || !userData) {
        return res.status(404).json({ error: 'User not found.' });
      }

      const extension = path.extname(req.file.originalname) || '';
      const newFileName = `${user_id}-${uuidv4()}${extension}`;

      // Step 1: Upload the image without compression.
      const imageUrl = await uploadImageToSupabase(req.file.buffer, newFileName);

      // --- MODIFICATION START ---
      // Step 2: Moderate the image with your custom CLIP model.
      const moderationResult = await moderateImageWithCustomModel(req.file.buffer, newFileName);
      let status = 'published';
      if (!moderationResult.approved) {
        status = 'manual_approval';
        console.warn(`Image sent for manual approval: ${moderationResult.reason}`);
      }
      // --- MODIFICATION END ---

      // Step 3: Classify the image using your custom model.
      const customClassifyResult = await classifyImageWithCustomModel(req.file.buffer, newFileName);
      const category = customClassifyResult.category;
      // styles is now already an array of strings thanks to the fix in classifyImageWithCustomModel
      const styles = customClassifyResult.styles;

      if (!category) {
        console.warn('No category returned from custom model, marking for manual approval.');
        status = 'manual_approval'; // If classification fails, also send for manual approval
      }

      // Decide the target table based on status.
      const targetTable = status === 'manual_approval' ? 'pending_wallpapers' : 'wallpapers';

      // Step 4: Insert the new wallpaper record.
      const { data: wallpaperData, error: wpError } = await supabaseAdmin
        .from(targetTable)
        .insert([{ user_id, title, description, image_url: imageUrl, status }])
        .select()
        .single();
      if (wpError) {
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
            const { data: newCat, error: newCatError } = await supabaseAdmin
              .from('categories')
              .insert([{ name: standardizedCategory }])
              .select()
              .single();
            if (!newCatError && newCat) {
              catId = newCat.id;
            } else if (newCatError) {
              console.error(`Error inserting new category "${standardizedCategory}":`, newCatError.message);
            }
          } else {
            catId = catData.id;
          }
          if (catId) {
            const { error: insertCatWpError } = await supabaseAdmin.from('wallpaper_categories').insert([{ wallpaper_id: wallpaperData.id, category_id: catId }]);
            if (insertCatWpError) {
              console.error(`Error linking category to wallpaper:`, insertCatWpError.message);
            }
          }
        }

        // Process styles.
        if (styles && styles.length > 0) {
          for (const styleName of styles) {
            // styleName is now guaranteed to be a string here due to the fix in classifyImageWithCustomModel
            const standardizedStyle = styleName.toLowerCase().trim();
            const { data: styleData, error: styleError } = await supabaseAdmin
              .from('styles')
              .select('id')
              .eq('name', standardizedStyle)
              .single();
            let styleId;
            if (styleError || !styleData) {
              const { data: newStyle, error: newStyleError } = await supabaseAdmin
                .from('styles')
                .insert([{ name: standardizedStyle }])
                .select()
                .single();
              if (!newStyleError && newStyle) {
                styleId = newStyle.id;
              } else if (newStyleError) {
                console.error(`Error inserting new style "${standardizedStyle}":`, newStyleError.message);
              }
            } else {
              styleId = styleData.id;
            }
            if (styleId) {
              const { error: insertStyleWpError } = await supabaseAdmin.from('wallpaper_styles').insert([{ wallpaper_id: wallpaperData.id, style_id: styleId }]);
              if (insertStyleWpError) {
                console.error(`Error linking style to wallpaper:`, insertStyleWpError.message);
              }
            }
          }
        }

        // Process hashtags.
        if (hashtags) {
          let tagList = [];
          if (typeof hashtags === 'string') {
            tagList = hashtags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
          } else if (Array.isArray(hashtags)) {
            tagList = hashtags;
          }
          for (const tag of tagList) {
            const standardizedTag = tag.toLowerCase().trim();
            const { data: tagData, error: tagError } = await supabaseAdmin
              .from('hashtags')
              .select('id')
              .eq('name', standardizedTag)
              .single();
            let hashtagId;
            if (tagError || !tagData) {
              const { data: newTag, error: newTagError } = await supabaseAdmin
                .from('hashtags')
                .insert([{ name: standardizedTag }])
                .select()
                .single();
              if (newTagError) {
                console.error(`Error creating hashtag "${tag}":`, newTagError.message);
                continue;
              }
              hashtagId = newTag.id;
            } else {
              hashtagId = tagData.id;
            }
            const { error: insertTagWpError } = await supabaseAdmin.from('wallpaper_hashtags').insert([{ wallpaper_id: wallpaperData.id, hashtag_id: hashtagId }]);
            if (insertTagWpError) {
              console.error(`Error linking hashtag to wallpaper:`, insertTagWpError.message);
            }
          }
        }
      }

      return res.status(201).json({ message: 'Wallpaper uploaded successfully!', wallpaper: wallpaperData });
    } catch (err) {
      console.error('Error in wallpaper upload:', err.message);
      return res.status(500).json({ error: 'Internal server error:' + err.message });
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
