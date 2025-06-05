const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

// Import your Supabase Admin client (adjust the path if needed)
const { supabaseAdmin } = require('../supabaseClient');

// Configure Nodemailer with your Gmail SMTP credentials
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_ADDRESS,    // e.g., pediapixal@gmail.com
    pass: process.env.EMAIL_PASSWORD,     // e.g., ccidahlhfbpldfmv
  },
});

// Helper function to count words in a string.
function wordCount(str) {
  if (!str) return 0;
  return str.trim().split(/\s+/).length;
}

// Word limits
const NAME_WORD_LIMIT = 20;
const SUBJECT_WORD_LIMIT = 20;
const MESSAGE_WORD_LIMIT = 500;

/**
 * POST /api/contact
 *
 * Expects a JSON body with:
 * {
 *   "user_id": "user's UUID",
 *   "name": "Sender's Name",
 *   "email": "sender@example.com",
 *   "subject": "Subject of Message",
 *   "message": "The message content"
 * }
 *
 * This route inserts the message into the contact_messages table and sends an email notification
 * to lakshitkhurana5678@gmail.com.
 */
router.post('/contact', async (req, res) => {
  const { user_id, name, email, subject, message } = req.body;

  // Validate that all fields are provided.
  if (!user_id || !name || !email || !subject || !message) {
    return res.status(400).json({ error: 'All fields (user_id, name, email, subject, message) are required.' });
  }

  // Validate word count limit for each field.
  if (wordCount(name) > NAME_WORD_LIMIT) {
    return res.status(400).json({ error: `Name cannot exceed ${NAME_WORD_LIMIT} words.` });
  }
  if (wordCount(subject) > SUBJECT_WORD_LIMIT) {
    return res.status(400).json({ error: `Subject cannot exceed ${SUBJECT_WORD_LIMIT} words.` });
  }
  if (wordCount(message) > MESSAGE_WORD_LIMIT) {
    return res.status(400).json({ error: `Message cannot exceed ${MESSAGE_WORD_LIMIT} words.` });
  }

  try {
    // Insert the contact message into the database (including user_id).
    const { data: contactData, error: dbError } = await supabaseAdmin
      .from('contact_messages')
      .insert([{ user_id, name, email, subject, message }])
      .single();

    if (dbError) {
      console.error('Error inserting contact message:', dbError.message);
      return res.status(500).json({ error: 'Failed to store contact message.' });
    }

    // Prepare the email notification options.
    const mailOptions = {
      from: process.env.EMAIL_ADDRESS,
      to: 'lakshitkhurana5678@gmail.com', // The email where you want to receive notifications.
      subject: `New Contact Message: ${subject}`,
      text: `You have received a new message from ${name} (${email}):\n\n${message}`,
    };

    // Send the email using SMTP via Nodemailer.
    transporter.sendMail(mailOptions, (mailError, info) => {
      if (mailError) {
        console.error('Error sending email:', mailError.message);
        return res.status(500).json({ error: 'Message stored but email notification failed.' });
      } else {
        return res.status(200).json({ message: 'Your message was received successfully. Thank you!' });
      }
    });
  } catch (err) {
    console.error('Error processing contact message:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * GET /api/contact/submitted/:user_id
 *
 * Checks if a contact message has been submitted for the given user_id.
 * Returns: { submitted: true } if exists, else { submitted: false }.
 */
router.get('/contact/submitted/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {
    // Query for any contact message by the given user_id.
    // Ordering by created_at and limiting to 1 record returns the earliest submission (or you could use DESC to get the latest).
    const { data, error } = await supabaseAdmin
      .from('contact_messages')
      .select('created_at')
      .eq('user_id', user_id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Error checking contact status:', error.message);
      return res.status(500).json({ error: 'Unable to check contact submission status.' });
    }

    if (data) {
      // Submission exists: return the created date along with submitted flag true.
      return res.status(200).json({ submitted: true, created_at: data.created_at });
    } else {
      // No submission found.
      return res.status(200).json({ submitted: false });
    }
  } catch (err) {
    console.error('Error fetching contact submission status:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
