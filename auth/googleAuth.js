const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const crypto = require('crypto');
const { supabase, supabaseAdmin } = require('../supabaseClient');
const { generatePublicAuthToken } = require('../utils/generateAuthToken');
const router = express.Router();

// Helper function to generate a random username (e.g., "user746372")
const generateRandomUsername = () => {
  return 'user' + Math.floor(100000 + Math.random() * 900000);
};

// Configure the Google OAuth strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Retrieve the user's email from the profile details provided by Google
        const email = profile.emails[0].value;
  
        // Attempt to find an existing user with the given email
        let { data: user, error } = await supabase
          .from('users')
          .select('*')
          .eq('email', email)
          .single();
  
        // If the user does not exist, create a new one with a random username
        if (error || !user) {
          const randomUsername = generateRandomUsername();
          const { data: newUser, error: insertError } = await supabaseAdmin
            .from('users')
            .insert({
              email: email,
              username: randomUsername,
              google_connected: true,
              created_at: new Date(),
            })
            .select()
            .single();
  
          if (insertError) {
            return done(insertError, null);
          }
          user = newUser;
        } else {
          // If the user exists but isn't marked as Google-connected, update the flag.
          if (!user.google_connected) {
            await supabaseAdmin
              .from('users')
              .update({ google_connected: true })
              .eq('id', user.id);
          }
        }
  
        // Upsert (insert or update) the Google login details in the `google_logins` table.
        const { error: googleLoginError } = await supabaseAdmin
          .from('google_logins')
          .upsert({
            user_id: user.id,
            google_id: profile.id,
            display_name: profile.displayName,
            family_name: profile.name.familyName,
            given_name: profile.name.givenName,
            email: email,
            picture: profile.photos && profile.photos.length ? profile.photos[0].value : null,
            raw_json: profile._json,
          }, {
            onConflict: 'google_id',
            ignoreDuplicates: false
          });
  
        if (googleLoginError) {
          console.error('Error upserting Google login data:', googleLoginError);
        }
  
        // Finalize authentication by returning the user.
        return done(null, user);
      } catch (err) {
        console.error('Error in GoogleStrategy:', err);
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return done(error, null);
  done(null, user);
});

// Route to start Google authentication with sessions disabled
router.get(
  '/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);

// Callback route for Google authentication with sessions disabled
router.get(
  '/google/callback',
  passport.authenticate('google', { failureRedirect: '/login', session: false }),
  async (req, res) => {
    try {
      // Generate the tokens
      const authToken = generatePublicAuthToken(req.user.id);
      const sessionId = crypto.randomBytes(16).toString('hex');
      const sessionToken = crypto.randomBytes(32).toString('hex');
  
      // Define expiration (e.g., 24 hours)
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  
      // Build device info using the request headers.
      const deviceInfo = {
        user_agent: req.headers['user-agent'] || '',
      };
  
      // Mark all existing manage_logins records for this user as logged out.
      const { error: updateExistingLoginsError } = await supabaseAdmin
        .from('manage_logins')
        .update({ is_logged_in: false })
        .eq('user_id', req.user.id);
      if (updateExistingLoginsError) {
        console.error('Error updating existing manage_logins records:', updateExistingLoginsError);
      }
  
      // Insert a record into the `manage_logins` table, marking this new login as active.
      const { error: manageLoginError } = await supabaseAdmin
        .from('manage_logins')
        .insert({
          user_id: req.user.id,
          session_id: sessionId,
          device_info: deviceInfo,
          method: 'google',
          auth_token: authToken,
          expires_at: expiresAt,
          ip_address: req.ip,
          is_logged_in: true
        });
      if (manageLoginError) {
        console.error('Error inserting manage_logins record:', manageLoginError);
      }
  
      // Insert a record into the `sessions` table.
      const generatedAt = Date.now();
      const { error: sessionError } = await supabaseAdmin
        .from('sessions')
        .insert({
          session_id: sessionId,
          session_token: sessionToken,
          user_agent: req.headers['user-agent'] || '',
          language: req.headers['accept-language'] || '',
          platform: '',
          screen_resolution: '',
          timezone_offset: null,
          generated_at: generatedAt,
          last_access: generatedAt,
        });
      if (sessionError) {
        console.error('Error inserting sessions record:', sessionError);
      }
  
      // Set tokens as HTTP-only cookies.
      res.cookie('auth_token', authToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'None'
      });
      res.cookie('session_token', sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'None'
      });
  
      // Redirect to frontend Google auth callback route with user data
        // Add this right before creating userData
      const frontendUrl = process.env.FRONTEND_URL || 'http://10.0.0.17:3000';
      const userData = encodeURIComponent(JSON.stringify({
        id: req.user.id,
        email: req.user.email,
        username: req.user.username,
        google_connected: req.user.google_connected,
        github_connected: req.user.github_connected,
        public_connected: req.user.public_connected,
        created_at: req.user.created_at
      }));
      
      return res.redirect(`${frontendUrl}/auth/google/callback?user=${userData}&authToken=${authToken}&sessionToken=${sessionToken}`);
    } catch (error) {
      console.error('Error generating tokens and session records:', error);
      const frontendUrl = process.env.FRONTEND_URL;
      return res.redirect(`${frontendUrl}/auth/google/callback?error=auth_failed`);
    }
  }
);

// Add new endpoint to get user data after OAuth redirect (same as GitHub)
router.get('/google/user', async (req, res) => {
  try {
    const authToken = req.cookies.auth_token;
    if (!authToken) {
      return res.status(401).json({ error: 'No auth token found' });
    }

    const userId = req.user?.id; // This would come from your auth middleware
    
    if (!userId) {
      return res.status(401).json({ error: 'Invalid auth token' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({
      message: "Google authentication successful",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        google_connected: user.google_connected,
        github_connected: user.github_connected,
        public_connected: user.public_connected,
        created_at: user.created_at
      },
      authToken: authToken,
      sessionToken: req.cookies.session_token
    });
  } catch (error) {
    console.error('Error fetching user data:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;