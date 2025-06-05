require("dotenv").config();
const express = require("express");
const passport = require("passport");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const morgan = require("morgan");
const os = require("os");
require('./Middleware/Keep_awake');

// Import your custom authentication and rate-limiting middleware
const authAndRateLimiterMiddleware = require("./Middleware/Middleware");

const app = express();

// Global middleware that applies to all requests
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));
app.use(
  cors({
    origin: [
      "http://localhost:3001",
      "http://127.0.0.1:5500",
      "http://10.0.0.17:3000",
      process.env.FRONTEND_URL,
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "login", "ts", "x-user-id", "authentication"],
    credentials: true,
  })
);

// Define paths where the auth middleware should not be enforced.
// Added OAuth endpoints here so that TS token checks are not applied.
const authExceptionPaths = [
  '/api/get-public-token', 
  '/auth/google',
  '/auth/github',
  '/auth/google/callback',
  '/auth/github/callback',
  '/auth/google/user',
  '/auth/github/user'
];

// Apply the auth middleware on all requests except the ones defined above.
app.use((req, res, next) => {
  if (authExceptionPaths.includes(req.path)) {
    return next();
  }
  return authAndRateLimiterMiddleware(req, res, next);
});

// Load additional utilities and configuration.
require("./utils/passport");
require("./utils/autoThumbnailUpdater");

// Import authentication routes for Google and GitHub.
const googleAuthRoutes = require("./auth/googleAuth");
const githubAuthRoutes = require("./auth/githubAuth");

// Import local authentication and public auth controllers.
const { signup, login } = require('./auth/publicAuth');
const {
  requestOTPForPasswordReset,
  resetPasswordWithOTP,
  verifyEmailWithOTP,
  resendOTP,
  checkUsername,
} = require('./auth/publicelement');

// Import your application's routes.
const profileRouter = require('./routes/profile');
const wallpaperRoutes = require('./routes/wallpaper');
const followRoutes = require('./routes/follow');
const reportRoutes = require('./routes/report');
const fetchRoutes = require("./routes/fetch");
const recommendations = require("./routes/recommendations");
const trendingLatestRoutes = require("./routes/wallpaperQueries");
const searchRoutes = require("./routes/searchRoutes");
const wallpaperPageRoutes = require("./routes/wallpaperPageRoutes");
const logoutRoutes = require("./auth/logout");
const proxyImageRoute = require("./Middleware/proxyImageRoute");
const settingsRouter = require('./routes/settings');
const contactRouter = require('./routes/contact');
const authRouter = require('./routes/auth');

// Register API endpoints.
app.use('/api/profile', profileRouter);
app.use('/api/wallpaper', wallpaperRoutes);
app.use('/api', followRoutes);
app.use('/api', reportRoutes);
app.use('/api/fetch', fetchRoutes);
app.use('/api', recommendations.router);
app.use('/api', trendingLatestRoutes);
app.use('/api', searchRoutes);
app.use('/api', wallpaperPageRoutes);
app.use('/api', logoutRoutes);
app.use('/proxy-image', proxyImageRoute);
app.use('/api/settings', settingsRouter);
app.use('/api/contact', contactRouter);
app.use('/api/auth', authRouter);

// Public authentication endpoints.
app.post('/signup', signup);
app.post('/login', login);
app.post('/request-password-reset-otp', requestOTPForPasswordReset);
app.post('/reset-password-with-otp', resetPasswordWithOTP);
app.post('/verify-email-with-otp', verifyEmailWithOTP);
app.post('/resend-otp', resendOTP);
app.post('/check-username', checkUsername);

// Initialize Passport and register social authentication routes.
app.use(passport.initialize());
app.use("/auth", googleAuthRoutes);
app.use("/auth", githubAuthRoutes);

// **START SERVER FOR LOCAL + RENDER**
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const renderUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`🚀 Server is running at: ${renderUrl}`);
});
