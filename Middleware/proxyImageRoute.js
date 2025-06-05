// proxyImageRoute.js
const express = require('express');
const { supabaseAdmin } = require('../supabaseClient'); // Use your preconfigured client
const router = express.Router();

/**
 * Proxy route to return an image.
 * Example: GET /proxy-image/images/wallpapers/1747542345681-photo-1558369178-6556d97855d0.jpeg
 */
router.get('/proxy-image/:imagePath', async (req, res) => {
  try {
    // Capture everything in the URL after /proxy-image/ using the wildcard
    const imagePath = req.params[0]; // e.g. "images/wallpapers/1747542345681-photo-1558369178-6556d97855d0.jpeg"
    
    // Request the image from Supabase Storage using the admin client
    const { data, error } = await supabaseAdmin
      .storage
      .from("your-storage-bucket-name") // Replace with your actual bucket name
      .download(imagePath);
    
    if (error || !data) {
      console.error("Error downloading image:", error);
      return res.status(404).send("Image not found");
    }
    
    // Set the appropriate Content-Type based on the returned file type.
    res.setHeader("Content-Type", data.type);
    
    // Pipe the file data directly to the response.
    data.pipe(res);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Internal server error");
  }
});

module.exports = router;
