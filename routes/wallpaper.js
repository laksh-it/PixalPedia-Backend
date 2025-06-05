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

// Initialize Supabase client (ensure environment variables are set)
const SUPABASE_URL = process.env.SUPABASE_URL; // e.g., "https://your-project.supabase.co"
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_KEY);

// Read the custom model URL from the environment variables.
const CUSTOM_MODEL_URL = process.env.CUSTOM_MODEL_URL;

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

// Helper Function: Analyze image with Microsoft Azure Cognitive Services for approval.
const analyzeImageWithAzure = async (imageBuffer) => {
  const AZURE_ENDPOINT = process.env.AZURE_ENDPOINT; // e.g., "https://<your-resource-name>.cognitiveservices.azure.com/"
  const AZURE_SUBSCRIPTION_KEY = process.env.AZURE_SUBSCRIPTION_KEY;
  const analyzeUrl = `${AZURE_ENDPOINT}/vision/v3.2/analyze?visualFeatures=Adult`;
  try {
    const response = await axios({
      method: 'post',
      url: analyzeUrl,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Ocp-Apim-Subscription-Key': AZURE_SUBSCRIPTION_KEY
      },
      data: imageBuffer
    });
    const result = response.data;
    const adult = result.adult;
    if (adult && (adult.isAdultContent || adult.isRacyContent)) {
      return { approved: false, reason: "Image flagged as adult or racy content." };
    }
    return { approved: true };
  } catch (err) {
    let reason = "Azure analysis error.";
    if (err.response && err.response.status === 429) {
      console.error('Azure free tier limit reached. Marking image for manual approval.');
      reason = "Azure free tier limit reached.";
    } else {
      console.error('Azure analysis error:', err.message);
    }
    return { approved: false, reason };
  }
};

// Helper Function: Classify the image using your custom model.
// Expected response format:
// {"category":"vintage","styles":["modern","minimalist","retro","grunge","abstract"]}
const classifyImageWithCustomModel = async (imageBuffer, newFileName) => {
  try {
    const form = new FormData();
    form.append('image', imageBuffer, { filename: newFileName });
    const response = await axios.post(CUSTOM_MODEL_URL, form, {
      headers: { ...form.getHeaders() }
    });
    const data = response.data;

    // Normalize the response to handle both response formats:
    // Example response:
    // {
    //   "category": "Spirituality",
    //   "score": 31.123933792114258,
    //   "stage": "extended",
    //   "styles": ["Spirituality", "God", "Festivals", "Poetry", "Animation"]
    // }
    // or:
    // {
    //   "category": "Visual & Digital Arts",
    //   "score": 31.867918014526367,
    //   "stage": "general",
    //   "styles": ["Nature Photography", "Environment", "Sustainability", "Conceptual Art", "Spirituality"]
    // }
    const standardizedResponse = {
      category: data.category || data.general_category,
      styles: data.styles || data.expanded_styles || data.general_styles || []
    };

    // Ensure we have at most 5 styles (truncate if necessary)
    standardizedResponse.styles = Array.isArray(standardizedResponse.styles)
      ? standardizedResponse.styles.slice(0, 5)
      : [];

    return standardizedResponse;
  } catch (err) {
    console.error('Error during custom model classification:', err.message);
    return { category: null, styles: [] };
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
    // Remove the validator for hashtags as custom logic will handle various formats.
  ],
  async (req, res) => {
    try {
      // Validate incoming fields.
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      let { user_id, title, description, hashtags } = req.body;
      
      // Check for hashtags array in case frontend uses field name "hashtags[]"
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
        return res.status(404).json({ error: 'User not found.' });
      }

      // Generate a new filename using user_id and a random UUID (preserving the file extension).
      const extension = path.extname(req.file.originalname) || '';
      const newFileName = `${user_id}-${uuidv4()}${extension}`;

      // Step 1: Upload the image without compression.
      const imageUrl = await uploadImageToSupabase(req.file.buffer, newFileName);

      // Step 2: Analyze the image with Azure for content approval.
      const azureResult = await analyzeImageWithAzure(req.file.buffer);
      let status = 'published';
      if (!azureResult.approved) {
        status = 'manual_approval';
      }

      // Step 3: Classify the image using your custom model.
      const customClassifyResult = await classifyImageWithCustomModel(req.file.buffer, newFileName);
      const category = customClassifyResult.category;
      let styles = Array.isArray(customClassifyResult.styles)
        ? customClassifyResult.styles.slice(0, 5)
        : [];
      if (!category) {
        console.warn('No category returned from custom model, marking for manual approval.');
        status = 'manual_approval';
      }

      // Decide the target table based on status.
      // If manual approval is needed, insert into 'pending_wallpapers'.
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
            }
          } else {
            catId = catData.id;
          }
          if (catId) {
            await supabaseAdmin.from('wallpaper_categories').insert([{ wallpaper_id: wallpaperData.id, category_id: catId }]);
          }
        }

        // Process styles.
        if (styles && styles.length > 0) {
          for (const styleName of styles) {
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
              }
            } else {
              styleId = styleData.id;
            }
            if (styleId) {
              await supabaseAdmin.from('wallpaper_styles').insert([{ wallpaper_id: wallpaperData.id, style_id: styleId }]);
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
            await supabaseAdmin.from('wallpaper_hashtags').insert([{ wallpaper_id: wallpaperData.id, hashtag_id: hashtagId }]);
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
