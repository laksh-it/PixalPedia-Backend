const { createClient } = require('@supabase/supabase-js');
require('dotenv').config(); // Load environment variables

// Initialize Supabase client (for standard operations)
const supabase = createClient(
    process.env.SUPABASE_URL,   // Supabase Project URL
    process.env.SUPABASE_KEY    // Public/anonymous API key
);

// Initialize Supabase admin client (for privileged operations)
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,  // Supabase Project URL
    process.env.SUPABASE_SERVICE_ROLE  // Service Role API key
);

// Log to confirm client initialization (for debugging)
console.log('✅ Supabase clients initialized');

// Export both Supabase clients
module.exports = { supabase, supabaseAdmin };
