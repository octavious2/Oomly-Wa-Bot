require('dotenv').config();

const { handleViewOnce } = require('./modules/viewOnce');
const { handleAntiDelete } = require('./modules/antiDelete');
const { handleAutoStatus } = require('./modules/ghostUtils');
const { getSettings, updateSetting } = require('./modules/settings');
const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "owner_secret_123";

// MTN MoMo Environment Credentials
const MOMO_SUBSCRIPTION_KEY = process.env.MOMO_SUBSCRIPTION_KEY || "";
const MOMO_API_USER = process.env.MOMO_API_USER || "";
const MOMO_API_KEY = process.env.MOMO_API_KEY || "";
const MOMO_ENV = process.env.MOMO_ENV || "sandbox";
const BOT_ACCESS_FEE = process.env.BOT_ACCESS_FEE || "10000";

// Memory Storage
const licenseStore = new Map();
const activeConnections = {};
const activeSockets = {};

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware: Validate Admin
const authenticateAdmin = (req, res, next) => {
    const key = req.headers['x-admin-key'] || req.query.adminKey;
    if (!key || key !== ADMIN_KEY) {
        return res.status(401).json({ success: false, error: "Unauthorized Master Admin Key" });
    }
    next();
};

// Middleware: Validate License / Admin Key for Dashboard & APIs
const validateLicenseKey = (req, res, next) => {
    const key = req.headers['x-admin-key'] || req.query.key;

    if (key && key === ADMIN_KEY) return next();

    if (!key || !licenseStore.has(key)) {
        return res.status(403).json({ 
            success: false, 
            error: "Invalid License Key. Complete MTN MoMo payment first." 
        });
    }

    const license = licenseStore.get(key);
    if (license.expiresAt && Date.now() > license.expiresAt) {
        return res.status(403).json({ 
            success: false, 
            error: "License Key has expired. Please renew via MTN MoMo." 
        });
    }

    req.licenseKey = key;
    req.licenseData = license;
    next();
};

// -------------------------------------------------------------
// MTN MOMO API INTEGRATION
// -------------------------------------------------------------
async function getMoMoToken() {
    const auth = Buffer.from(`${MOMO_API_USER}:${MOMO_API_KEY}`).toString('base64');
    const response = await axios.post(
        `https://sandbox.momodeveloper.mtn.com/collection/token/`,
        {},
        {
            headers: {
                'Authorization': `Basic ${auth}`,
                'Ocp-Apim-Subscription-Key': MOMO_SUBSCRIPTION_KEY
            }
        }
    );
    return response.data.access_token;
}

app.post('/api/momo/pay', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: "Phone number required" });

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const referenceId = crypto.randomUUID();

    try {
        const token = await getMoMoToken();
        await axios.post(
            `https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay`,
            {
                amount: BOT_ACCESS_FEE,
                currency: "EUR",
                externalId: referenceId,
                payer: { partyIdType: "MSISDN", partyId: cleanPhone },
                payerMessage: "Payment for Oomly WhatsApp Bot License",
                payeeNote: "Oomly License Purchase"
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Reference-Id': referenceId,
                    'X-Target-Environment': MOMO_ENV,
                    'Ocp-Apim-Subscription-Key': MOMO_SUBSCRIPTION_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            message: "MTN MoMo prompt sent to phone. Enter PIN on phone to complete.",
            referenceId
        });
    } catch (e) {
        console.error("MoMo Pay Error:", e.response?.data || e.message);
        res.status(500).json({ success: false, error: e.response?.data?.errorDescription || e.message });
    }
});

app.get('/api/momo/verify/:referenceId', async (req, res) => {
    const { referenceId } = req.params;

    try {
        const token = await getMoMoToken();
        const response = await axios.get(
            `https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay/${referenceId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Target-Environment': MOMO_ENV,
                    'Ocp-Apim-Subscription-Key': MOMO_SUBSCRIPTION_KEY
                }
            }
        );

        const status = response.data.status;

        if (status === 'SUCCESSFUL') {
            let generatedKey = null;
            for (let [key, data] of licenseStore.entries()) {
                if (data.refId === referenceId) {
                    generatedKey = key;
                    break;
                }
            }

            if (!generatedKey) {
                const rawCode = crypto.randomBytes(4).toString('hex').toUpperCase();
                generatedKey = `OOMLY-MOMO-${rawCode}`;
                licenseStore.set(generatedKey, {
                    redeemed: false,
                    refId: referenceId,
                    createdAt: new Date()
                });
                console.log(`💰 [MTN MOMO PAID]: Generated key ${generatedKey}`);
            }

            return res.json({ success: true, paid: true, licenseKey: generatedKey });
        } else if (status === 'FAILED') {
            return res.json({ success: true, paid: false, status: "FAILED" });
        } else {
            return res.json({ success: true, paid: false, status: "PENDING" });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: "Verification failed" });
    }
});

// -------------------------------------------------------------
// SOCKET INITIALIZER (With Singleton Guard against 440 Conflicts)
// -------------------------------------------------------------
async function connectToWhatsApp(userId, req = null) {
    // If a socket instance already exists and is active, return it to prevent duplicate login collision
    if (activeSockets[userId] && activeConnections[userId]) {
        return activeSockets[userId];
    }

    const sessionDir = path.join(__dirname, 'sessions', userId);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.0"],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        markOnlineOnConnect: true,
        // Prevent background crash throws on dropped transaction frames
        emitOwnEvents: false,
    });

    activeSockets[userId] = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            activeConnections[userId] = true;
            console.log(`✅ [WHATSAPP CONNECTED] for user ${userId}`);

            if (req && req.licenseKey && licenseStore.has(req.licenseKey)) {
                licenseStore.get(req.licenseKey).redeemed = true;
            }
        } else if (connection === 'close') {
            activeConnections[userId] = false;
            delete activeSockets[userId];
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Connection closed. Status Code: ${statusCode}`);

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(`🔄 [RECONNECTING]: Initializing fresh handshake reconnect for ${userId}...`);
                setTimeout(() => connectToWhatsApp(userId), 3000);
            } else {
                console.log(`❌ [LOGGED OUT]: Wiping session data for ${userId}`);
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            }
        }
    });

sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const chatJid = msg.key.remoteJid;
            const sender = msg.key.participant || chatJid;
            const keys = Object.keys(msg.message);
            console.log(`📥 [INCOMING MESSAGE]: From ${sender} | Type Keys:`, keys);

            await handleViewOnce(sock, msg).catch(e => console.error("ViewOnce Error:", e.message));
            await handleAntiDelete(sock, msg).catch(e => console.error("AntiDelete Error:", e.message));
            await handleAutoStatus(sock, msg).catch(e => console.error("AutoStatus Error:", e.message));
        } catch (err) {
            console.error("Message upsert loop error:", err);
        }
    });

    return sock;
}

// -------------------------------------------------------------
// CLIENT API: Link WhatsApp
// -------------------------------------------------------------
app.post('/api/pair', validateLicenseKey, async (req, res) => {
    const { phone, userId } = req.body;
    if (!phone || !userId) {
        return res.status(400).json({ success: false, error: "Phone number and userId required" });
    }

    let cleanNumber = phone.replace(/[^0-9]/g, '');
    if (cleanNumber.startsWith('0') && cleanNumber.length === 10) {
        cleanNumber = '256' + cleanNumber.substring(1);
    }

    const sessionDir = path.join(__dirname, 'sessions', userId);

    try {
        const sock = await connectToWhatsApp(userId, req);

        if (!sock.authState.creds.registered) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            const code = await sock.requestPairingCode(cleanNumber);
            return res.json({ success: true, pairingCode: code });
        } else {
            activeConnections[userId] = true;
            return res.json({ success: true, pairingCode: "ALREADY_LINKED" });
        }
    } catch (e) {
        console.error("Pairing Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/status', validateLicenseKey, (req, res) => {
    const { userId } = req.query;
    const sessionDir = path.join(__dirname, 'sessions', userId);
    const hasCreds = fs.existsSync(path.join(sessionDir, 'creds.json'));
    
    const isConnected = !!activeConnections[userId] || hasCreds;
    res.json({ connected: isConnected });
});

app.get('/api/vault', validateLicenseKey, (req, res) => {
    res.json({ success: true, vault: global.deletedVault || [] });
});

app.get('/api/viewonce-vault', validateLicenseKey, (req, res) => {
    res.json({ success: true, vault: global.viewOnceVault || [] });
});

app.get('/api/settings', validateLicenseKey, (req, res) => {
    res.json({ success: true, settings: getSettings() });
});

app.post('/api/settings', validateLicenseKey, express.json(), (req, res) => {
    const { key, value } = req.body;
    const updated = updateSetting(key, value);
    if (updated) {
        res.json({ success: true, settings: getSettings() });
    } else {
        res.status(400).json({ success: false, error: "Invalid setting key" });
    }
});

// Startup: Restore saved session once without double initialization race conditions
const sessionsBasePath = path.join(__dirname, 'sessions');
if (fs.existsSync(sessionsBasePath)) {
    const existingUsers = fs.readdirSync(sessionsBasePath);
    existingUsers.forEach(userId => {
        const userCredsFile = path.join(sessionsBasePath, userId, 'creds.json');
        if (fs.existsSync(userCredsFile)) {
            console.log(`📂 [SESSION RESTORED]: Booting socket for ${userId}`);
            connectToWhatsApp(userId);
        }
    });
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 MTN MoMo Automated Bot Server active on port ${PORT}`);
    console.log(`🔑 [MASTER ADMIN KEY]: ${ADMIN_KEY}`);
});