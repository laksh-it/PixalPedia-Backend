const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const GitHubStrategy = require("passport-github2").Strategy;
const { supabase, supabaseAdmin } = require("../supabaseClient");

// --------------------- Google Strategy ---------------------
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Retrieve the user's email from the profile details provided by Google.
        const email = profile.emails[0].value;

        // Attempt to find an existing user with the given email.
        let { data: user, error } = await supabase
          .from("users")
          .select("*")
          .eq("email", email)
          .single();

        // If the user does not exist, create a new one.
        if (error || !user) {
          const { data: newUser, error: insertError } = await supabaseAdmin
            .from("users")
            .insert({
              email,
              username: profile.displayName || profile.username,
              google_connected: true,
              created_at: new Date(),
            })
            .select()
            .single();
          if (insertError) return done(insertError, null);
          user = newUser;
        } else if (!user.google_connected) {
          // If the user exists but isn't marked as Google-connected, update the flag.
          await supabaseAdmin
            .from("users")
            .update({ google_connected: true })
            .eq("id", user.id);
        }

        // Upsert (insert or update) the Google login details in the `google_logins` table.
        const { error: googleLoginError } = await supabaseAdmin
          .from("google_logins")
          .upsert({
            user_id: user.id,
            google_id: profile.id,
            display_name: profile.displayName,
            family_name: profile.name.familyName,
            given_name: profile.name.givenName,
            email,
            picture:
              profile.photos && profile.photos.length
                ? profile.photos[0].value
                : null,
            raw_json: profile._json,
            created_at: new Date(),
          });
        if (googleLoginError)
          console.error("Error upserting Google login data:", googleLoginError);

        // Finalize authentication by returning the user.
        return done(null, user);
      } catch (err) {
        console.error("Error in GoogleStrategy:", err);
        return done(err, null);
      }
    }
  )
);

// --------------------- GitHub Strategy ---------------------
passport.use(
  new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: process.env.GITHUB_CALLBACK_URL,
      scope: ["user:email"],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Retrieve the user's email from the profile details provided by GitHub.
        // GitHub may return multiple emails; we take the first available.
        const emailObj = profile.emails && profile.emails[0];
        const email = emailObj ? emailObj.value : null;
        if (!email) {
          return done(new Error("No email found in GitHub profile"), null);
        }

        // Attempt to find an existing user with the given email.
        let { data: user, error } = await supabase
          .from("users")
          .select("*")
          .eq("email", email)
          .single();

        // If the user does not exist, create a new one.
        if (error || !user) {
          const { data: newUser, error: insertError } = await supabaseAdmin
            .from("users")
            .insert({
              email,
              username: profile.displayName || profile.username,
              github_connected: true,
              created_at: new Date(),
            })
            .select()
            .single();
          if (insertError) return done(insertError, null);
          user = newUser;
        } else if (!user.github_connected) {
          // If the user exists but isn't marked as GitHub-connected, update the flag.
          await supabaseAdmin
            .from("users")
            .update({ github_connected: true })
            .eq("id", user.id);
        }

        // Upsert (insert or update) the GitHub login details in the `github_logins` table.
        // Provide a fallback for display_name if profile.displayName is null.
        const displayName = profile.displayName || profile.username || 'GitHub User';
        const { error: githubLoginError } = await supabaseAdmin
          .from("github_logins")
          .upsert({
            user_id: user.id,
            github_id: profile.id,
            display_name: displayName,
            username: profile.username,
            email,
            picture:
              profile.photos && profile.photos.length
                ? profile.photos[0].value
                : null,
            raw_json: profile._json,
            created_at: new Date(),
          });
        if (githubLoginError)
          console.error("Error upserting GitHub login data:", githubLoginError);

        // Finalize authentication by returning the user.
        return done(null, user);
      } catch (err) {
        console.error("Error in GitHubStrategy:", err);
        return done(err, null);
      }
    }
  )
);

// --------------------- Serialization ---------------------
passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", id)
    .single();
  error ? done(error, null) : done(null, user);
});

module.exports = passport;
