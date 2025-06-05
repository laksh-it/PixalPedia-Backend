const pingServer = () => {
    require('https').get('https://retail-backend-k7ix.onrender.com', (res) => {
        console.log(`Pinged Render! Status Code: ${res.statusCode}`);
    }).on("error", (err) => {
        console.error("Ping failed:", err.message);
    });
};

// Log when the script starts
console.log("✅ Keep-Alive Script Started");

// Trigger first ping immediately
pingServer();

// Set interval to keep pinging every 5 minutes
setInterval(pingServer, 300000);
