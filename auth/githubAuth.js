const express = require('express');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const crypto = require('crypto');
const { supabase, supabaseAdmin } = require('../supabaseClient');
const { generatePublicAuthToken } = require('../utils/generateAuthToken');

const router = express.Router();

// Configure the GitHub OAuth strategy
passport.use(
  new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: process.env.GITHUB_CALLBACK_URL,
      scope: ['user:email'],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const emailObj = profile.emails && profile.emails[0];
        const email = emailObj ? emailObj.value : null;
        if (!email) {
          return done(new Error("No email found in GitHub profile"), null);
        }
  
        let { data: user, error } = await supabase
          .from('users')
          .select('*')
          .eq('email', email)
          .single();
  
        if (error || !user) {
          const generateRandomUsername = () => {
            return "user" + Math.floor(100000 + Math.random() * 900000);
          };
  
          const randomUsername = generateRandomUsername();
  
          const { data: newUser, error: insertError } = await supabaseAdmin
            .from('users')
            .insert({
              email: email,
              username: randomUsername,
              github_connected: true,
              created_at: new Date(),
            })
            .select()
            .single();
  
          if (insertError) {
            return done(insertError, null);
          }
          user = newUser;
        } else {
          if (!user.github_connected) {
            await supabaseAdmin
              .from('users')
              .update({ github_connected: true })
              .eq('id', user.id);
          }
        }
  
        const displayName = profile.displayName || profile.username || 'GitHub User';
  
        const { error: githubLoginError } = await supabaseAdmin
          .from('github_logins')
          .upsert({
            user_id: user.id,
            github_id: profile.id,
            display_name: displayName,
            username: profile.username,
            email: email,
            picture: profile.photos && profile.photos.length ? profile.photos[0].value : null,
            raw_json: profile._json,
          }, {
            onConflict: 'github_id',
            ignoreDuplicates: false
          });
  
        if (githubLoginError) {
          console.error("Error upserting GitHub login data:", githubLoginError);
        }
  
        return done(null, user);
      } catch (err) {
        console.error("Error in GitHubStrategy:", err);
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
  error ? done(error, null) : done(null, user);
});

// Route to initiate GitHub authentication
router.get(
  '/github',
  passport.authenticate('github', { scope: ['user:email'], session: false })
);

// Modified callback route - redirect with tokens instead of JSON response
router.get(
  '/github/callback',
  passport.authenticate('github', { failureRedirect: '/login', session: false }),
  async (req, res) => {
    try {
      const authToken = generatePublicAuthToken(req.user.id);
      const sessionId = crypto.randomBytes(16).toString('hex');
      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const deviceInfo = { user_agent: req.headers['user-agent'] || '' };
  
      // Mark all existing manage_logins records for this user as logged out
      const { error: updateExistingLoginsError } = await supabaseAdmin
        .from('manage_logins')
        .update({ is_logged_in: false })
        .eq('user_id', req.user.id);
      if (updateExistingLoginsError) {
        console.error('Error updating existing manage_logins records:', updateExistingLoginsError);
      }
  
      // Insert new login record
      const { error: manageLoginError } = await supabaseAdmin
        .from('manage_logins')
        .insert({
          user_id: req.user.id,
          session_id: sessionId,
          device_info: deviceInfo,
          method: 'github',
          auth_token: authToken,
          expires_at: expiresAt,
          ip_address: req.ip,
          is_logged_in: true
        });
      if (manageLoginError) {
        console.error('Error inserting manage_logins record:', manageLoginError);
      }
  
      // Insert session record
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
  
      // Set cookies
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
  
      // Redirect to your existing GitHub auth route with user data in URL params
      const frontendUrl = process.env.FRONTEND_URL || 'http://172.20.10.2:3001';
      const userData = encodeURIComponent(JSON.stringify({
        id: req.user.id,
        email: req.user.email,
        username: req.user.username,
        github_connected: req.user.github_connected,
        google_connected: req.user.google_connected,
        public_connected: req.user.public_connected,
        created_at: req.user.created_at
      }));
      
      // Redirect to your existing GitHub auth callback route
      return res.redirect(`${frontendUrl}/auth/github/callback?user=${userData}&authToken=${authToken}&sessionToken=${sessionToken}`);
    } catch (error) {
      console.error('Error generating tokens and session records:', error);
      const frontendUrl = process.env.FRONTEND_URL;
      return res.redirect(`${frontendUrl}/auth/github/callback?error=auth_failed`);
    }
  }
);

// Add new endpoint to get user data after OAuth redirect
router.get('/github/user', async (req, res) => {
  try {
    const authToken = req.cookies.auth_token;
    if (!authToken) {
      return res.status(401).json({ error: 'No auth token found' });
    }

    // You'll need to decode the auth token to get user ID
    // This depends on your generatePublicAuthToken implementation
    // For now, assuming you have a way to get user ID from token
    
    // Alternative: get user from session or token validation
    // This is a placeholder - implement based on your auth token structure
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
      message: "GitHub authentication successful",
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