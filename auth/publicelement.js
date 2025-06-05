const nodemailer = require('nodemailer');
const { supabase} = require('../supabaseClient'); // Import Supabase clients
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Buffer } = require('buffer');

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
    <h1 style="font-size: 24px; margin-bottom: 20px;">Welcome to <strong>Your Company Name</strong>!</h1>
    
    <!-- OTP Container -->
    <div style="font-size: 32px; font-weight: bold; background-color: #eceff1; color: #000; padding: 15px; border: 1px solid #ddd; border-radius: 5px; display: inline-block; margin: 20px auto;">
        ${otp}
    </div>
    
    <p style="font-size: 16px; color: #666; margin: 20px;">Your verification code is <strong>valid for 10 minutes</strong>. Use it to continue with <strong>${purpose}</strong>.</p>
    
    <!-- Logo Section -->
    <div style="margin: 30px auto;">
        <img src="https://vrkxxjqualipkaicqorj.supabase.co/storage/v1/object/public/images/Logo%20lakshit.PNG" 
            alt="Company Logo" 
            style="max-width: 150px; height: auto; border-radius: 10px;" />
    </div>
    
    <p style="font-size: 14px; color: #666;">We appreciate your trust in <strong>Your Company Name</strong>. If you have any questions, feel free to contact us.</p>
    
    <!-- Footer -->
    <div style="font-size: 12px; color: #999; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 10px;">
        <p style="margin: 0;">[Your Company Name] | Contact: info@yourcompany.com</p>
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

// Function to check email verification status
const isEmailVerified = async (email) => {
    try {
        // Normalize the email
        const sanitizedEmail = email.trim().toLowerCase();

        // Fetch the user's verification status from the database
        const { data: user, error: userError } = await supabase
            .from('public_logins')
            .select('is_email_verified') // Correct field based on your table schema
            .eq('email', sanitizedEmail)
            .single();

        if (userError || !user) {
            console.error('User not found or error fetching user:', userError?.message);
            return { verified: false, error: 'User not found or an error occurred.' };
        }

        // Return the verification status
        return { verified: user.is_email_verified, error: null };
    } catch (err) {
        console.error('Verification Check Error:', err.message);
        return { verified: false, error: 'An unexpected error occurred during verification.' };
    }
};

// VerifyEmailwithotp fucntion
const verifyEmailWithOTP = async (req, res) => {
    const { email, otp } = req.body;

    try {
        // Input validation
        if (!email || !otp) {
            return res.status(400).json({ error: 'Email and OTP are required.' });
        }

        // Normalize email for case-insensitivity
        const sanitizedEmail = email.trim().toLowerCase();
        console.log('Sanitized Email:', sanitizedEmail);
        console.log('Provided OTP:', otp);

        // Fetch the OTP record
        const { data: otpRecord, error: otpError } = await supabase
            .from('otps')
            .select('*')
            .eq('email', sanitizedEmail)
            .eq('otp', otp)
            .eq('purpose', 'email_verification')
            .single();

        console.log('OTP Record:', otpRecord);
        console.log('OTP Query Error:', otpError);

        // Validate OTP record
        if (otpError || !otpRecord) {
            return res.status(400).json({ error: 'Invalid or expired OTP.' });
        }

        // Check if the OTP has expired
        if (new Date(otpRecord.expires_at) < new Date()) {
            console.error('Expired OTP:', otpRecord);
            return res.status(400).json({ error: 'Invalid or expired OTP.' });
        }

        console.log('Valid OTP Record:', otpRecord);

        // Mark the user as email verified
        const { error: updateError } = await supabase
            .from('public_logins')
            .update({ is_email_verified: true })
            .eq('email', sanitizedEmail);

        if (updateError) {
            console.error('Email Verification Update Error:', updateError.message);
            throw new Error('Failed to update email verification.');
        }

        console.log('Email verified successfully for:', sanitizedEmail);

        res.status(200).json({ message: 'Email verified successfully!' });
    } catch (err) {
        console.error('Verification Error:', err.message);
        res.status(500).json({ error: 'Verification failed.', details: err.message });
    }
};


// Request OTP for password reset
const requestOTPForPasswordReset = async (req, res) => {
    const { email } = req.body;
  
    try {
        if (!email) {
            return res.status(400).json({ error: 'Email is required.' });
        }

        // Normalize the email to lowercase for consistency
        const sanitizedEmail = email.trim().toLowerCase();

        // Step 1: Check if email exists in the users table
        const { data: user, error: userError } = await supabase
            .from('public_logins')
            .select('id') // Select only the 'id' field for verification
            .eq('email', sanitizedEmail)
            .single(); // Expect only one user

        if (userError && userError.code !== 'PGRST116') {
            console.error('Error checking user existence:', userError.message);
            throw new Error('Error checking user existence.');
        }

        if (!user) {
            // If user with the provided email does not exist
            return res.status(404).json({ error: 'No account found with this email address.' });
        }

        // Step 2: Generate a new OTP
        const otp = generateOTP(); // Generate a new OTP
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // OTP valid for 10 minutes
        console.log('Generated OTP and expiration time:', { otp, expiresAt });

        // Step 3: Delete existing OTPs for the same email and purpose
        const { error: deleteError } = await supabase
            .from('otps')
            .delete()
            .match({ email: sanitizedEmail, purpose: 'password_reset' });

        if (deleteError) {
            console.error('Error deleting existing OTPs:', deleteError.message);
            throw new Error('Failed to delete previous OTPs.');
        }
        console.log('Old OTPs deleted successfully for:', sanitizedEmail);

        // Step 4: Insert the new OTP into the database
        const { error: insertError } = await supabase
            .from('otps')
            .insert([
                {
                    email: sanitizedEmail,
                    otp,
                    purpose: 'password_reset',
                    expires_at: expiresAt,
                },
            ]);

        if (insertError) {
            console.error('Error inserting new OTP:', insertError.message);
            throw new Error('Failed to insert new OTP.');
        }
        console.log('New OTP inserted successfully for:', sanitizedEmail);

        // Step 5: Send the OTP email
        await sendOTPEmail(sanitizedEmail, otp, 'password reset');
        console.log('OTP email sent successfully to:', sanitizedEmail);

        // Step 6: Respond with success
        res.status(200).json({ message: 'OTP sent for password reset. Please check your email.' });
    } catch (err) {
        console.error('Error in requestOTPForPasswordReset:', err.message);
        res.status(400).json({ error: 'Request OTP failed.', details: err.message });
    }
};

// Reset Password with OTP
const resetPasswordWithOTP = async (req, res) => {
    const { email, otp, new_password } = req.body;
  
    try {
      // Validate input
      if (!email || !otp || !new_password) {
        return res.status(400).json({ error: 'All fields are required!' });
      }
  
      // Normalize email to ensure case-insensitivity
      const sanitizedEmail = email.trim().toLowerCase();
      console.log('Sanitized Email:', sanitizedEmail);
      console.log('Provided OTP:', otp);
  
      // Hash the new password
      const hashedPassword = await bcrypt.hash(new_password, 10);
  
      // Fetch the OTP record with email, otp, and purpose validation
      const { data: otpRecord, error: otpError } = await supabase
        .from('otps')
        .select('*')
        .eq('email', sanitizedEmail) // Always use sanitized email
        .eq('otp', otp)
        .eq('purpose', 'password_reset')
        .single();
  
      console.log('OTP Record:', otpRecord);
      console.log('OTP Query Error:', otpError);
  
      // Validate OTP record and check for errors
      if (otpError || !otpRecord) {
        return res.status(400).json({ error: 'Invalid OTP' });
      }
  
      // Check OTP expiration
      if (new Date(otpRecord.expires_at) < new Date()) {
        console.error('Expired OTP:', otpRecord);
        return res.status(400).json({ error: 'Expired OTP' });
      }
  
      console.log('Valid OTP Record:', otpRecord);
  
      // Update the user's password in the database
      const { error: updateError } = await supabase
        .from('public_logins')
        .update({ password: hashedPassword })
        .eq('email', sanitizedEmail); // Use sanitized email for the update
  
      if (updateError) {
        console.error('Password Update Error:', updateError.message);
        throw new Error('Password update failed');
      }
  
      console.log('Password updated successfully for:', sanitizedEmail);
  
      // Invalidate the OTP after password reset
      const { error: invalidateError } = await supabase
        .from('otps')
        .delete()
        .match({ id: otpRecord.id });
  
      if (invalidateError) {
        console.error('Error invalidating OTP:', invalidateError.message);
        throw new Error('Failed to invalidate OTP');
      }
  
      console.log('OTP invalidated successfully for:', sanitizedEmail);
  
      res.status(200).json({ message: 'Password reset successful!' });
    } catch (err) {
      console.error('Error in resetPasswordWithOTP:', err.message);
      res.status(500).json({ error: 'Reset password failed', details: err.message });
    }
  };  

  // Resend OTP Function
  const otpRequests = {}; // Temporary store for tracking OTP requests by email or IP

const resendOTP = async (req, res) => {
      const { email, purpose } = req.body;
  
      try {
          // Input validation
          if (!email || !purpose) {
              return res.status(400).json({ error: 'Email and purpose are required.' });
          }
  
          // Validate purpose
          const allowedPurposes = ['password_reset', 'email_verification'];
          if (!allowedPurposes.includes(purpose)) {
              return res.status(400).json({ error: 'Invalid purpose specified.' });
          }
  
          // Normalize email for case-insensitivity
          const sanitizedEmail = email.trim().toLowerCase();
  
          // For purpose "email_verification", check if email is already verified
          if (purpose === 'email_verification') {
              const verificationStatus = await isEmailVerified(sanitizedEmail); // Check email verification status
              if (verificationStatus.verified) {
                  return res.status(400).json({ error: 'This email is already verified.' });
              }
              if (verificationStatus.error) {
                  return res.status(500).json({ error: verificationStatus.error });
              }
          }
  
          const otp = generateOTP(); // Generate a new OTP
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // OTP valid for 10 minutes
          const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress; // Track IP address
  
          console.log('Generated OTP:', otp);
          console.log('Sanitized Email:', sanitizedEmail);
          console.log('Request Purpose:', purpose);
  
          // Rate-limiting: Allow max 3 OTP requests per email per hour
          if (!otpRequests[sanitizedEmail]) {
              otpRequests[sanitizedEmail] = { count: 0, lastRequest: Date.now() };
          } else if (
              otpRequests[sanitizedEmail].count >= 3 &&
              Date.now() - otpRequests[sanitizedEmail].lastRequest < 60 * 60 * 1000
          ) {
              return res.status(429).json({ error: 'Too many OTP requests. Please try again later.' });
          }
  
          // Invalidate existing OTPs for the same purpose
          await supabase.from('otps').delete().match({ email: sanitizedEmail, purpose });
  
          // Send the new OTP via email
          await sendOTPEmail(sanitizedEmail, otp, purpose);
  
          // Insert the new OTP into the database
          const { error } = await supabase.from('otps').insert([{ email: sanitizedEmail, otp, purpose, expires_at: expiresAt }]);
          if (error) throw error;
  
          console.log('Inserted new OTP into the database for:', sanitizedEmail);
  
          // Update OTP request tracking for this email
          otpRequests[sanitizedEmail].count++;
          otpRequests[sanitizedEmail].lastRequest = Date.now();
  
          // Respond with success
          res.status(200).json({ message: `A new OTP has been sent for ${purpose}. Please check your email.` });
      } catch (err) {
          console.error('Resend OTP Error:', err.message);
          res.status(500).json({ error: 'Resend OTP failed. Please try again later.', details: err.message });
      }
  };  


// Check if a Username Exists
const checkUsername =  async (req, res) => {
    const { username } = req.body;
  
    try {
      if (!username) {
        return res.status(400).json({ error: 'Username is required.' });
      }
  
      // Validate length: must be between 3 and 20 characters.
      if (username.length < 3 || username.length > 20) {
        return res
          .status(400)
          .json({ error: 'Username must be between 3 and 20 characters long.' });
      }
  
      // Validate characters: only letters and numbers allowed (no spaces, special characters, or emojis).
      if (!/^[A-Za-z0-9]+$/.test(username)) {
        return res.status(400).json({
          error:
            'Username can only contain letters and numbers without spaces or special characters.',
        });
      }
  
      // Check if the username already exists in the database.
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('id') // Only check for existence
        .eq('username', username)
        .single();
  
      if (userError && userError.code === 'PGRST116') {
        // "No rows found" - username is available
        return res.status(200).json({ isAvailable: true });
      }
  
      if (userError) {
        // Other errors
        console.error('Error checking username:', userError.message);
        return res
          .status(500)
          .json({ error: 'Failed to check username availability.' });
      }
  
      // Username exists
      return res.status(200).json({ isAvailable: false });
    } catch (err) {
      console.error('Unexpected Error:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    }
  };  

// Export all handlers
module.exports = {
    requestOTPForPasswordReset,
    resetPasswordWithOTP,
    verifyEmailWithOTP,
    resendOTP,
    checkUsername,
};
