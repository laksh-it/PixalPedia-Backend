const nodemailer = require('nodemailer');
const { supabase, supabaseAdmin } = require('../supabaseClient'); // Import Supabase clients
const bcrypt = require('bcryptjs');
const crypto = require('crypto');


// Helper to generate 6-digit OTP
const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// Configure nodemailer for Gmail SMTP
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_ADDRESS,  // Gmail address
        pass: process.env.EMAIL_PASSWORD // Gmail app password
    },
});

// Function to send OTP via email
const sendOTPEmail = async (email, otp, purpose) => {
    const mailOptions = {
        from: process.env.EMAIL_ADDRESS,
        to: email,
        subject: `Your OTP for ${purpose}`, // Dynamic subject based on purpose
        html: `
           <div style="font-family: Arial, sans-serif; text-align: center; color: #333; padding: 30px;">
    <h1 style="font-size: 24px; margin-bottom: 20px;">Welcome to <strong>PixalPedia</strong>!</h1>
    
    <!-- OTP Container -->
    <div style="font-size: 32px; font-weight: bold; background-color: #eceff1; color: #000; padding: 15px; border: 1px solid #ddd; border-radius: 5px; display: inline-block; margin: 20px auto;">
        ${otp}
    </div>
    
    <p style="font-size: 16px; color: #666; margin: 20px;">Your verification code is <strong>valid for 10 minutes</strong>. Use it to continue with <strong>${purpose}</strong>.</p>
    
    <!-- Logo Section -->
    <div style="margin: 30px auto;">
        <img src="https://aoycxyazroftyzqlrvpo.supabase.co/storage/v1/object/public/images//logo%202.jpeg" 
            alt="Company Logo" 
            style="max-width: 150px; height: auto; border-radius: 10px;" />
    </div>
    
    <p style="font-size: 14px; color: #666;">We appreciate your trust in <strong>PixalPedia</strong>. If you have any questions, feel free to contact us.</p>
    
    <!-- Footer -->
    <div style="font-size: 12px; color: #999; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 10px;">
        <p style="margin: 0;">PixalPedia | Contact: pediapixal@gmail.com/p>
        <p style="margin: 0;">If you didn’t request this, please ignore this email.</p>
    </div>
</div>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`OTP sent to ${email}`);
    } catch (error) {
        console.error('Error sending OTP email:', error.message);
        throw new Error('Failed to send OTP email');
    }
};

// Helper function to generate a unique username by trimming the user input
// and appending 6 random digits (e.g., if input is "lakshit", it may produce "lakshit746372").
const generateUniqueUsername = (providedUsername) => {
  const base = providedUsername.trim();
  const randomDigits = Math.floor(100000 + Math.random() * 900000);
  return base + randomDigits;
};

const signup = async (req, res) => {
  const { email, password, username } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress; // Get user's IP address

  try {
    // Basic input validation
    if (!email || !password || !username) {
      return res.status(400).json({ error: "All fields are required." });
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email format." });
    }

    // Validate password strength
    if (
      password.length < 8 ||
      !/[A-Za-z]/.test(password) ||
      !/[0-9]/.test(password)
    ) {
      return res.status(400).json({
        error:
          "Password must be at least 8 characters long and include letters and numbers.",
      });
    }

    // Normalize email and generate unique username using client input (trimmed with 6 random digits)
    const sanitizedEmail = email.trim().toLowerCase();
    const generatedUsername = generateUniqueUsername(username);

    // === Step 0: Check in the "users" table ===
    // If a user with this email exists, do NOT update the username (keep it as is);
    // Otherwise, create a new user with public_connected: true using the generated username.
    let userRecord;
    const { data: existingUserInUsers, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("email", sanitizedEmail)
      .single();
    if (userError && userError.code !== "PGRST116") {
      throw new Error("Error fetching user from users table: " + userError.message);
    }
    if (existingUserInUsers) {
      // User exists; preserve the existing username.
      userRecord = existingUserInUsers;
    } else {
      // Create a new user with the generated username.
      const { data: newUser, error: newUserError } = await supabaseAdmin
        .from("users")
        .insert({
          email: sanitizedEmail,
          username: generatedUsername,
          public_connected: true,
          created_at: new Date(),
        })
        .select()
        .single();
      if (newUserError) {
        throw new Error("Error creating new user: " + newUserError.message);
      }
      userRecord = newUser;
    }

    // === Step 1: Check if email already exists in public_logins ===
    const {
      data: existingPublicLogin,
      error: existingPublicLoginError,
    } = await supabase
      .from("public_logins")
      .select("id")
      .eq("email", sanitizedEmail)
      .single();
    if (
      existingPublicLoginError &&
      existingPublicLoginError.code !== "PGRST116"
    ) {
      throw new Error("Error checking public logins: " + existingPublicLoginError.message);
    }
    if (existingPublicLogin) {
      return res
        .status(409)
        .json({ error: "Email already exists. Please use a different email address." });
    }

    // === Step 2: Rate-limiting ===
    const { data: signupData, error: signupError } = await supabase
      .from("signup_limits")
      .select("*")
      .eq("ip_address", ip)
      .eq("email", sanitizedEmail)
      .single();
    if (signupError && signupError.code !== "PGRST116") {
      throw new Error("Error fetching signup limits: " + signupError.message);
    }
    if (signupData) {
      const attemptsExceeded =
        signupData.attempts >= 5 &&
        Date.now() - new Date(signupData.last_attempt).getTime() < 60 * 60 * 1000;
      if (attemptsExceeded) {
        return res.status(429).json({
          error: "Too many signup attempts from this IP. Please try again later.",
        });
      }
      // Update signup attempts
      const { error: updateAttemptsError } = await supabase
        .from("signup_limits")
        .update({
          attempts: signupData.attempts + 1,
          last_attempt: new Date(),
        })
        .eq("id", signupData.id);
      if (updateAttemptsError) {
        throw new Error("Error updating signup attempts: " + updateAttemptsError.message);
      }
    } else {
      // Insert a new record for signup attempts
      const { error: insertAttemptError } = await supabase
        .from("signup_limits")
        .insert([
          {
            ip_address: ip,
            email: sanitizedEmail,
            attempts: 1,
            last_attempt: new Date(),
          },
        ]);
      if (insertAttemptError) {
        throw new Error("Error inserting signup attempt record: " + insertAttemptError.message);
      }
    }

    // === Step 3: Hash the password ===
    const hashedPassword = await bcrypt.hash(password, 10);

    // === Step 4: Insert the user into the public_logins table ===
    // Include the user_id from the users table and use the generated username.
    const { data: publicLoginData, error: publicLoginError } = await supabase
      .from("public_logins")
      .insert([
        {
          user_id: userRecord.id,
          email: sanitizedEmail,
          password: hashedPassword,
          username: generatedUsername,
        },
      ])
      .select();
    if (publicLoginError) {
      throw new Error("Error inserting into public logins: " + publicLoginError.message);
    }

    // --- New Step: Ensure the user record has public_connected: true ---
    const { error: updatePublicConnectedError } = await supabaseAdmin
      .from("users")
      .update({ public_connected: true })
      .eq("id", userRecord.id);
    if (updatePublicConnectedError) {
      throw new Error("Error updating public_connected in users table: " + updatePublicConnectedError.message);
    }

    // === Step 5: Delete any existing OTPs for email verification ===
    const { error: deleteOtpError } = await supabase
      .from("otps")
      .delete()
      .eq("email", sanitizedEmail)
      .eq("purpose", "email_verification");
    if (deleteOtpError) {
      throw new Error("Error deleting existing OTPs: " + deleteOtpError.message);
    }

    // === Step 6: Generate OTP for email verification ===
    const otp = generateOTP();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // OTP valid for 10 minutes
    console.log("Generated OTP and expiration time:", { otp, expiresAt: otpExpiresAt });
    
    const { error: insertOtpError } = await supabase
      .from("otps")
      .insert([
        {
          email: sanitizedEmail,
          otp,
          purpose: "email_verification",
          expires_at: otpExpiresAt,
        },
      ]);
    if (insertOtpError) {
      throw new Error("Error inserting OTP record: " + insertOtpError.message);
    }

    // === Step 7: Send OTP email ===
    try {
      await sendOTPEmail(sanitizedEmail, otp, "email verification");
    } catch (emailError) {
      throw new Error("Error sending OTP email: " + emailError.message);
    }

    // === Final Step: Respond with success ===
    return res.status(201).json({
      message:
        "Signup successful! Please verify your email using the OTP sent to your email.",
      user: {
        id: userRecord.id,
        email: sanitizedEmail,
        username: generatedUsername,
      },
    });
  } catch (err) {
    console.error("Signup Error:", err.message);
    return res.status(500).json({ error: "Signup failed.", details: err.message });
  }
};


// Helper: Generate a public auth token by merging the user ID with a secret.
const generatePublicAuthToken = (userId) => {
  const secret = process.env.USER_TOKEN_SECRET;
  if (!secret) {
    throw new Error('USER_TOKEN_SECRET is not set in environment variables');
  }
  const splitIndex = Math.floor(secret.length / 2);
  const secretFirst = secret.slice(0, splitIndex);
  const secretSecond = secret.slice(splitIndex);
  const merged = secretFirst + userId + secretSecond;
  const encodedMerged = Buffer.from(merged).toString('base64');
  const prefix = crypto.randomBytes(10).toString('hex'); // 20 hex characters
  const suffix = crypto.randomBytes(8).toString('hex');    // 16 hex characters
  return prefix + encodedMerged + suffix;
};

// Function to handle user login
const login = async (req, res) => {
  const { email, password } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  try {
    // Input validation with specific messages
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Password is required.' });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    // Retrieve the user's public login record.
    const { data: loginData, error: loginError } = await supabase
      .from('public_logins')
      .select('id, user_id, username, email, password, is_email_verified')
      .eq('email', sanitizedEmail)
      .single();

    if (loginError || !loginData) {
      return res.status(404).json({ error: 'User not found. Please register first.' });
    }

    // Ensure the email has been verified.
    if (!loginData.is_email_verified) {
      return res.status(403).json({ error: 'Email not verified. Please verify your email before logging in.' });
    }

    // Fetch failed login attempts (if any)
    const { data: attemptRecord, error: attemptError } = await supabase
      .from('failed_login_attempts')
      .select('*')
      .eq('email', sanitizedEmail)
      .eq('ip_address', ip)
      .single();

    if (attemptError && attemptError.code !== 'PGRST116') {
      console.error('Error fetching failed login attempts:', attemptError);
      return res.status(500).json({ error: 'Error processing login attempt. Please try again later.' });
    }

    // Check if the account is temporarily locked from too many failed attempts.
    if (
      attemptRecord &&
      attemptRecord.failed_attempts >= 5 &&
      new Date() < new Date(attemptRecord.locked_until)
    ) {
      const lockRemaining = calculateLockRemaining(attemptRecord.locked_until); // assumed helper function
      return res.status(403).json({
        error: `Too many failed attempts. Account is locked. Try again after ${lockRemaining} minutes.`
      });
    }

    // Compare the provided password with the stored hash.
    const isPasswordCorrect = await bcrypt.compare(password, loginData.password);
    if (!isPasswordCorrect) {
      await handleFailedLogin(sanitizedEmail, ip, attemptRecord); // assumed helper function
      return res.status(401).json({ error: 'Password is incorrect.' });
    }

    // Mark any previously active sessions for this user as logged out.
    // This will update all manage_logins entries for the user by setting is_logged_in to false.
    const { error: updateExistingLoginsError } = await supabaseAdmin
      .from('manage_logins')
      .update({ is_logged_in: false })
      .eq('user_id', loginData.user_id);
    if (updateExistingLoginsError) {
      console.error('Error updating existing manage_logins records:', updateExistingLoginsError);
      // Optionally log the error but continue with current login.
    }

    // Generate authentication token and session details.
    const publicAuthToken = generatePublicAuthToken(loginData.user_id);
    const sessionId = crypto.randomBytes(16).toString('hex');
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour expiry
    const deviceInfo = { user_agent: req.headers['user-agent'] || '' };

    // Insert the new session record in the manage_logins table.
    const { error: manageLoginError } = await supabaseAdmin
      .from('manage_logins')
      .insert({
        user_id: loginData.user_id,
        session_id: sessionId,
        device_info: deviceInfo,
        method: 'public',
        auth_token: publicAuthToken,
        expires_at: expiresAt,
        is_logged_in: true,
        ip_address: ip
      });
    if (manageLoginError) {
      console.error('Error inserting manage_logins record:', manageLoginError);
      return res.status(500).json({ error: 'Login failed due to session management error. Please try again.' });
    }

    // Insert a record in the sessions table.
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
        last_access: generatedAt
      });
    if (sessionError) {
      console.error('Error inserting sessions record:', sessionError);
      return res.status(500).json({ error: 'Login failed due to session creation error. Please try again.' });
    }

    // Set HTTP-only cookies for tokens.
    res.cookie('auth_token', publicAuthToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production'
    });
    res.cookie('session_token', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production'
    });

    // Return successful login response.
    return res.status(200).json({
      message: 'Login successful.',
      user: {
        id: loginData.user_id,
        username: loginData.username,
        email: loginData.email
      },
      authToken: publicAuthToken,
      sessionToken: sessionToken
    });
  } catch (err) {
    console.error('Login Error:', err.message);
    return res.status(500).json({
      error: 'Login failed. Please try again.',
      details: err.message
    });
  }
};

// Helper function: Calculate lock remaining time
const calculateLockRemaining = (lockedUntil) => {
    return Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000); // Remaining minutes
};

// Helper function: Handle failed login attempt
const handleFailedLogin = async (email, ip, attemptRecord) => {
    const newFailedAttempts = attemptRecord ? attemptRecord.failed_attempts + 1 : 1;
    const lockUntil = newFailedAttempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : null; // Lock for 30 minutes after 5 failed attempts

    if (attemptRecord) {
        // Update failed login attempts in the database
        await supabase
            .from('failed_login_attempts')
            .update({
                failed_attempts: newFailedAttempts,
                locked_until: lockUntil,
            })
            .eq('email', email)
            .eq('ip_address', ip);
    } else {
        // Insert new failed login attempt record
        await supabase
            .from('failed_login_attempts')
            .insert([
                {
                    email,
                    ip_address: ip,
                    failed_attempts: 1,
                    locked_until: null,
                },
            ]);
    }
};

// Export all handlers
module.exports = {
    signup,
    login,
};