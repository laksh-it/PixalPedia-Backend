// profile.js

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// Initialize Supabase client (ensure environment variables are set)
const SUPABASE_URL = process.env.SUPABASE_URL; // e.g., "https://your-project.supabase.co"
const SUPABASE_KEY = process.env.SUPABASE_KEY; // Your supabase service or anon key
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_KEY);

// Set up Multer for memory storage (no disk usage)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 } // Maximum file size of 4MB
});

// Helper Function: Compress and Upload Image to Supabase Storage
const uploadImageToSupabase = async (buffer, fileName) => {
  try {
    // Compress & resize image to a maximum size of 1024x1024 (maintaining aspect ratio)
    const compressedImage = await sharp(buffer)
      .resize(1024, 1024, { fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer();

    // Create a unique file path using a timestamp
    const timestamp = Date.now();
    const filePath = `profiles/${timestamp}-${fileName}`;

    // Upload the image using Supabase Storage (bucket name: 'images')
    const { data, error } = await supabaseAdmin.storage
      .from('images')
      .upload(filePath, compressedImage, {
        cacheControl: '3600',
        upsert: false,
        contentType: 'image/jpeg'
      });

    if (error) {
      console.error('Supabase upload error:', error.message);
      throw new Error('Image upload failed.');
    }

    // Construct and return the public URL for the image
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/images/${filePath}`;
    return publicUrl;
  } catch (err) {
    console.error('Error during image upload:', err.message);
    throw err;
  }
};

// API Endpoint: Create Initial Profile
// Expects a multipart/form-data payload with optional dp file
// Fields: user_id, name, bio, optional social_links, and optional username.
// If username is not provided, it is fetched from the "users" table based on user_id.
router.post(
  "/add",
  upload.single("dp"),
  async (req, res) => {
    try {
      // Extract fields from request body
      const { user_id, name, bio, social_links } = req.body;
      let { username } = req.body;

      // Validate required fields
      if (!user_id || !name) {
        return res.status(400).json({ error: "user_id and name are required." });
      }

      // Validate bio word count (up to 200 words)
      if (bio) {
        const words = bio.trim().split(/\s+/);
        if (words.length > 200) {
          return res.status(400).json({ error: "Bio must be 200 words or less." });
        }
      }

      // Validate social_links: maximum of five links allowed (if provided)
      if (social_links) {
        // Assuming social_links is a comma-separated string.
        const links = social_links
          .split(",")
          .map(link => link.trim())
          .filter(link => link.length > 0);
        if (links.length > 5) {
          return res.status(400).json({ error: "A maximum of 5 social links are allowed." });
        }
      }

      // Update or fetch username from the users table
      if (username) {
        // If a new username is provided, update the users table.
        // We use .select() instead of .single() so that a 204 (no content) response does not trigger an error.
        const { data: updatedUser, error: updateError } = await supabaseAdmin
          .from("users")
          .update({ username })
          .eq("id", user_id)
          .select();

        if (updateError) {
          console.error("Error updating username in users table:", updateError.message);
          return res.status(400).json({ error: "Error updating username in users table: " + updateError.message });
        }
        // If no record is returned, log a warning but assume success.
        if (!updatedUser || updatedUser.length === 0) {
          console.warn("No record returned after updating username; assuming update successful.");
        }
      } else {
        // If username is not provided, fetch it from the users table.
        const { data: userData, error: userFetchError } = await supabaseAdmin
          .from("users")
          .select("username")
          .eq("id", user_id)
          .single();

        if (userFetchError || !userData) {
          return res.status(400).json({ error: "Username not provided and could not be fetched." });
        }
        username = userData.username;
      }

      let dpUrl = null;
      // If a profile picture file (dp) is provided, process and upload it.
      if (req.file) {
        dpUrl = await uploadImageToSupabase(req.file.buffer, req.file.originalname);
      }

      // Accept social_links as is (either a JSON string or CSV as per your front-end)
      const socialLinksData = social_links || null;

      // Insert the new profile into the "profiles" table.
      const { data, error } = await supabaseAdmin
        .from("profiles")
        .insert([
          {
            user_id,
            username,
            dp: dpUrl,
            name,
            bio,
            social_links: socialLinksData,
          },
        ])
        .select()
        .single();

      if (error) {
        console.error("Error inserting profile:", error.message);
        return res.status(500).json({ error: error.message });
      }

      res.status(201).json({ message: "Profile created successfully!", profile: data });
    } catch (err) {
      console.error("Error creating profile:", err.message);
      res.status(500).json({ error: "Internal server error: " + err.message });
    }
  }
);

// =====================================================
// GET /api/profile/search?username=<username>
// =====================================================
// This endpoint searches for a profile by username.
// It returns a JSON object with a property "profile" containing:
// { id, username, dp } if a matching profile is found.
router.get('/search', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ error: "username query parameter is required." });
    }

    // Query the profiles table for the provided username
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, username, dp')
      .eq('username', username)
      .single();

    if (error) {
      console.error("Error searching for profile:", error.message);
      return res.status(404).json({ error: "Profile not found." });
    }

    return res.status(200).json({ profile: data });
  } catch (err) {
    console.error("Error while searching for profile:", err.message);
    res.status(500).json({ error: "Internal server error: " + err.message });
  }
});

// GET /api/insights/:user_id
// Returns an insights report for the given user, aggregating metrics such as profile views, 
// followers, and wallpaper statistics (views, downloads, shares, likes, and reports).
// GET /api/insights/:user_id
// Returns an insights report that includes overall metrics (aggregated from profiles and wallpapers)
// as well as monthly comparisons for views, downloads, shares, likes, and reports on the user’s wallpapers.
router.get('/insights/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    // 1. Get Profile Metrics (from the profiles table)
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('profile_views, followers_count, following_count')
      .eq('user_id', user_id)
      .single();
    if (profileError) {
      return res.status(500).json({ error: 'Error fetching profile data: ' + profileError.message });
    }

    // 2. Get Wallpapers Metrics (cumulative) from wallpapers table
    const { data: wallpapersData, error: wallpapersError } = await supabaseAdmin
      .from('wallpapers')
      .select('id, view_count, download_count, share_count, like_count')
      .eq('user_id', user_id);
    if (wallpapersError) {
      return res.status(500).json({ error: 'Error fetching wallpapers data: ' + wallpapersError.message });
    }
    
    let totalUploaded = 0,
      totalViews = 0,
      totalDownloads = 0,
      totalShares = 0,
      totalLikes = 0;
    const wallpaperIds = [];
    
    if (wallpapersData && wallpapersData.length > 0) {
      totalUploaded = wallpapersData.length;
      wallpapersData.forEach((w) => {
        totalViews += Number(w.view_count || 0);
        totalDownloads += Number(w.download_count || 0);
        totalShares += Number(w.share_count || 0);
        totalLikes += Number(w.like_count || 0);
        wallpaperIds.push(w.id);
      });
    }
    
    // 3. Get Reports Metrics (cumulative) for wallpapers
    let totalReports = 0;
    if (wallpaperIds.length > 0) {
      const { error: reportsError, count } = await supabaseAdmin
        .from('reports')
        .select('id', { count: 'exact' })
        .eq('element_type', 'wallpaper')
        .in('element_id', wallpaperIds);
      if (reportsError) {
        return res.status(500).json({ error: 'Error fetching reports data: ' + reportsError.message });
      }
      totalReports = count || 0;
    }
    
    // 4. Define date boundaries for monthly comparisons.
    // Current month: from the 1st of this month to the 1st of next month.
    // Previous month: from the 1st of last month to the 1st of this month.
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    
    // 5. Query monthly metrics only if the user has wallpapers.
    let monthlyComparisons = {};
    if (wallpaperIds.length > 0) {
      // Wallpaper Views
      const { error: viewsCurrentError, count: currentViews } = await supabaseAdmin
        .from('wallpaper_views')
        .select('id', { count: 'exact' })
        .in('wallpaper_id', wallpaperIds)
        .gte('created_at', currentMonthStart.toISOString())
        .lt('created_at', nextMonthStart.toISOString());
      if (viewsCurrentError) {
        return res.status(500).json({ error: 'Error fetching current month views: ' + viewsCurrentError.message });
      }
      const { error: viewsPrevError, count: prevViews } = await supabaseAdmin
        .from('wallpaper_views')
        .select('id', { count: 'exact' })
        .in('wallpaper_id', wallpaperIds)
        .gte('created_at', previousMonthStart.toISOString())
        .lt('created_at', currentMonthStart.toISOString());
      if (viewsPrevError) {
        return res.status(500).json({ error: 'Error fetching previous month views: ' + viewsPrevError.message });
      }
      
      // Wallpaper Downloads
      const { error: downloadsCurrentError, count: currentDownloads } = await supabaseAdmin
        .from('wallpaper_downloads')
        .select('id', { count: 'exact' })
        .in('wallpaper_id', wallpaperIds)
        .gte('created_at', currentMonthStart.toISOString())
        .lt('created_at', nextMonthStart.toISOString());
      if (downloadsCurrentError) {
        return res.status(500).json({ error: 'Error fetching current month downloads: ' + downloadsCurrentError.message });
      }
      const { error: downloadsPrevError, count: prevDownloads } = await supabaseAdmin
        .from('wallpaper_downloads')
        .select('id', { count: 'exact' })
        .in('wallpaper_id', wallpaperIds)
        .gte('created_at', previousMonthStart.toISOString())
        .lt('created_at', currentMonthStart.toISOString());
      if (downloadsPrevError) {
        return res.status(500).json({ error: 'Error fetching previous month downloads: ' + downloadsPrevError.message });
      }
      
      // Wallpaper Shares
      const { error: sharesCurrentError, count: currentShares } = await supabaseAdmin
        .from('wallpaper_shares')
        .select('id', { count: 'exact' })
        .in('wallpaper_id', wallpaperIds)
        .gte('created_at', currentMonthStart.toISOString())
        .lt('created_at', nextMonthStart.toISOString());
      if (sharesCurrentError) {
        return res.status(500).json({ error: 'Error fetching current month shares: ' + sharesCurrentError.message });
      }
      const { error: sharesPrevError, count: prevShares } = await supabaseAdmin
        .from('wallpaper_shares')
        .select('id', { count: 'exact' })
        .in('wallpaper_id', wallpaperIds)
        .gte('created_at', previousMonthStart.toISOString())
        .lt('created_at', currentMonthStart.toISOString());
      if (sharesPrevError) {
        return res.status(500).json({ error: 'Error fetching previous month shares: ' + sharesPrevError.message });
      }
      
      // Wallpaper Likes (using liked_at timestamp)
      const { error: likesCurrentError, count: currentLikes } = await supabaseAdmin
        .from('wallpaper_likes')
        .select('wallpaper_id', { count: 'exact' })
        .in('wallpaper_id', wallpaperIds)
        .gte('liked_at', currentMonthStart.toISOString())
        .lt('liked_at', nextMonthStart.toISOString());
      if (likesCurrentError) {
        return res.status(500).json({ error: 'Error fetching current month likes: ' + likesCurrentError.message });
      }
      const { error: likesPrevError, count: prevLikes } = await supabaseAdmin
        .from('wallpaper_likes')
        .select('wallpaper_id', { count: 'exact' })
        .in('wallpaper_id', wallpaperIds)
        .gte('liked_at', previousMonthStart.toISOString())
        .lt('liked_at', currentMonthStart.toISOString());
      if (likesPrevError) {
        return res.status(500).json({ error: 'Error fetching previous month likes: ' + likesPrevError.message });
      }
      
      // Wallpaper Reports (for element_type 'wallpaper')
      const { error: reportsCurrentError, count: currentReports } = await supabaseAdmin
        .from('reports')
        .select('id', { count: 'exact' })
        .eq('element_type', 'wallpaper')
        .in('element_id', wallpaperIds)
        .gte('created_at', currentMonthStart.toISOString())
        .lt('created_at', nextMonthStart.toISOString());
      if (reportsCurrentError) {
        return res.status(500).json({ error: 'Error fetching current month reports: ' + reportsCurrentError.message });
      }
      const { error: reportsPrevError, count: prevReports } = await supabaseAdmin
        .from('reports')
        .select('id', { count: 'exact' })
        .eq('element_type', 'wallpaper')
        .in('element_id', wallpaperIds)
        .gte('created_at', previousMonthStart.toISOString())
        .lt('created_at', currentMonthStart.toISOString());
      if (reportsPrevError) {
        return res.status(500).json({ error: 'Error fetching previous month reports: ' + reportsPrevError.message });
      }
      
      // Helper function to calculate change and percentage
      const calcChange = (current, previous) => {
        const diff = current - previous;
        const percentage = previous === 0 ? (current === 0 ? 0 : 100) : (diff / previous) * 100;
        return { diff, percentage };
      };
      
      monthlyComparisons = {
        views: {
          current: currentViews,
          previous: prevViews,
          ...calcChange(currentViews, prevViews)
        },
        downloads: {
          current: currentDownloads,
          previous: prevDownloads,
          ...calcChange(currentDownloads, prevDownloads)
        },
        shares: {
          current: currentShares,
          previous: prevShares,
          ...calcChange(currentShares, prevShares)
        },
        likes: {
          current: currentLikes,
          previous: prevLikes,
          ...calcChange(currentLikes, prevLikes)
        },
        reports: {
          current: currentReports,
          previous: prevReports,
          ...calcChange(currentReports, prevReports)
        }
      };
    }
    
    // 6. Compose the final insights report object
    const insights = {
      profileInsights: {
        profile_views: profileData.profile_views || 0,
        followers_count: profileData.followers_count || 0,
        following_count: profileData.following_count || 0
      },
      wallpapersInsights: {
        total_uploaded: totalUploaded,
        total_views: totalViews,
        total_downloads: totalDownloads,
        total_shares: totalShares,
        total_likes: totalLikes,
        total_reports: totalReports
      },
      monthlyComparisons
    };
    
    // Return the insights as JSON for consumption (e.g., by front-end charts/graphs)
    return res.status(200).json({ insights });
  } catch (err) {
    console.error('Error fetching insights:', err.message);
    return res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});

/**
 * GET /api/profile/exists/:user_id
 *
 * Checks if a profile exists for the given user_id.
 * Returns:
 * - { exists: true } if a profile is found.
 * - { exists: false } otherwise.
 */
router.get('/exists/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {
    // Query the profiles table to check for an entry with this user_id.
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('user_id', user_id)
      .maybeSingle();

    if (error) {
      console.error("Error checking profile existence:", error.message);
      return res.status(500).json({ error: "Internal server error." });
    }

    // If an entry is returned in data, the profile exists.
    const exists = data ? true : false;
    return res.status(200).json({ exists });
  } catch (err) {
    console.error("Error while checking profile existence:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// API Endpoint: Change Username (Once per month)
// Expects: user_id and new_username in the request body.
router.put('/username-change', async (req, res) => {
  try {
    const { user_id, new_username } = req.body;
    
    // Validate required fields
    if (!user_id || !new_username) {
      return res.status(400).json({ error: 'user_id and new_username are required.' });
    }
    
    // Check if the new_username is already taken in the users table
    const { data: existingUser, error: existingError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('username', new_username)
      .single();
    
    if (existingError === null && existingUser) {
      return res.status(409).json({ error: 'Username is already taken. Please choose another one.' });
    }
    
    // Fetch the last username change timestamp from the profiles table
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('username_change_requested_at')
      .eq('user_id', user_id)
      .single();
    
    if (profileError) {
      return res.status(500).json({ error: 'Error retrieving profile data.' });
    }
    
    const lastChangeTimestamp = profileData.username_change_requested_at ? new Date(profileData.username_change_requested_at) : null;
    const now = new Date();
    const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000; // Approximate one month in milliseconds
    
    if (lastChangeTimestamp && (now - lastChangeTimestamp < ONE_MONTH_MS)) {
      const remainingTime = ONE_MONTH_MS - (now - lastChangeTimestamp);
      const remainingDays = Math.ceil(remainingTime / (24 * 60 * 60 * 1000));
      return res.status(403).json({
        error: `Username can only be changed once per month. Please try again in about ${remainingDays} day(s).`
      });
    }
    
    // Update the users table with the new username
    const { error: updateUserError } = await supabaseAdmin
      .from('users')
      .update({ username: new_username })
      .eq('id', user_id);
    
    if (updateUserError) {
      return res.status(500).json({ error: 'Failed to update username in users table.' });
    }
    
    // Update the profiles table with the new username and record the change timestamp
    const { data: updatedProfile, error: updateProfileError } = await supabaseAdmin
      .from('profiles')
      .update({ 
        username: new_username,
        username_change_requested_at: now
      })
      .eq('user_id', user_id)
      .select()
      .single();
    
    if (updateProfileError) {
      return res.status(500).json({ error: 'Failed to update username in profiles table.' });
    }
    
    res.status(200).json({ message: 'Username updated successfully!', profile: updatedProfile });
    
  } catch (err) {
    console.error('Error during username update:', err.message);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});

// API Endpoint: Update Profile Information (except username)
// Route: /update
// Expects: multipart/form-data with fields: user_id, optional dp, name, bio, and social_links.
// API Endpoint: Update Profile Information (except username)
// Route: /update
// API Endpoint: Update Profile Information (except username)
// Route: /update
router.put('/update', upload.single('dp'), async (req, res) => {
  try {
    const { user_id, name, bio, social_links, dp } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required.' });
    }

    // Validate bio length: allow only up to 200 words.
    if (bio) {
      const words = bio.trim().split(/\s+/);
      if (words.length > 200) {
        return res.status(400).json({ error: 'Bio must be 200 words or less.' });
      }
    }

    // Validate social_links: maximum 5 links allowed.
    if (social_links) {
      // Assuming the social_links field is a comma-separated string.
      const links = social_links.split(',')
        .map(link => link.trim())
        .filter(link => link.length > 0);
      
      if (links.length > 5) {
        return res.status(400).json({ error: 'A maximum of 5 social links are allowed.' });
      }
    }

    let newDpUrl = null;
    let shouldRemoveDp = false;

    // Fetch existing profile data to get the current display picture (dp)
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('dp')
      .eq('user_id', user_id)
      .single();

    if (profileError) {
      return res.status(500).json({ error: 'Error retrieving profile data.' });
    }

    const oldDpUrl = profileData?.dp;

    // Check if user wants to remove the profile picture
    if (dp === "remove") {
      shouldRemoveDp = true;
      
      // If an old DP exists, delete it from the Storage bucket
      if (oldDpUrl) {
        // Extract the file path from the stored URL
        const filePathParts = oldDpUrl.split('/storage/v1/object/public/images/');
        if (filePathParts.length > 1) {
          const filePath = filePathParts[1];

          // Remove the file from the 'images' bucket
          const { error: deleteError } = await supabaseAdmin.storage
            .from('images')
            .remove([filePath]);

          if (deleteError) {
            console.error(`Error deleting profile image (${filePath}): ${deleteError.message}`);
            return res.status(500).json({ error: 'Failed to delete existing profile picture.' });
          } else {
            console.log(`Successfully deleted old profile image: ${filePath}`);
          }
        } else {
          console.warn('Old DP URL format is unexpected; could not extract file path.');
        }
      }
    }
    // If a new profile picture is uploaded, process & upload it
    else if (req.file) {
      newDpUrl = await uploadImageToSupabase(req.file.buffer, req.file.originalname);

      // If an old DP exists, delete it from the Storage bucket
      if (oldDpUrl) {
        // Extract the file path from the stored URL
        const filePathParts = oldDpUrl.split('/storage/v1/object/public/images/');
        if (filePathParts.length > 1) {
          const filePath = filePathParts[1];

          // Attempt to remove the file from the 'images' bucket
          const { error: deleteError } = await supabaseAdmin.storage
            .from('images')
            .remove([filePath]);

          if (deleteError) {
            // Log the deletion error, but do not fail the overall update
            console.error(`Error deleting old profile image (${filePath}): ${deleteError.message}`);
          } else {
            console.log(`Successfully deleted old profile image: ${filePath}`);
          }
        } else {
          console.warn('Old DP URL format is unexpected; could not extract file path.');
        }
      }
    }

    // Build the update object from the provided fields
    const updateFields = {};
    if (name) updateFields.name = name;
    if (bio) updateFields.bio = bio;
    if (social_links) updateFields.social_links = social_links;
    
    // Handle dp field updates
    if (shouldRemoveDp) {
      updateFields.dp = null; // Set to null to remove the dp
    } else if (newDpUrl) {
      updateFields.dp = newDpUrl; // Set to new uploaded image URL
    }

    // Update the profiles table with any changed fields
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(updateFields)
      .eq('user_id', user_id)
      .select()
      .single();

    if (error) {
      console.error('Error updating profile:', error.message);
      return res.status(500).json({ error: 'Failed to update profile.' });
    }

    res.status(200).json({ 
      message: 'Profile updated successfully!', 
      profile: data,
      ...(shouldRemoveDp && { note: 'Profile picture removed successfully.' })
    });

  } catch (err) {
    console.error('Unexpected error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// API Endpoint: Request Verification
router.post('/request-verification', async (req, res) => {
    const { user_id, request_reason } = req.body;

    if (!user_id || !request_reason) {
        return res.status(400).json({ error: 'user_id and request_reason are required.' });
    }

    // Check if user already submitted a request
    const { data: existingRequest, error: checkError } = await supabaseAdmin
        .from('verification_requests')
        .select('*')
        .eq('user_id', user_id)
        .single();

    if (existingRequest) {
        return res.status(409).json({ error: 'You already have a pending or reviewed request.' });
    }

    // Insert new verification request
    const { data, error } = await supabaseAdmin
        .from('verification_requests')
        .insert([{ user_id, request_reason }])
        .select()
        .single();

    error ? res.status(500).json({ error }) : res.status(201).json({ message: 'Verification request submitted!', request: data });
});


module.exports = router;
