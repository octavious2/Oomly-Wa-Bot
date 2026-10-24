const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "owner_secret_123";

// Memory Storage for One-Time License Keys
// Format: { "KEY-XXXX-YYYY": { redeemed: false, createdAt: Date.now() } }
const licenseStore = new Map();

const activeConnections = {};
const messageCache = new Map();
const deletedVault = [];

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware: Validate Master Admin
const authenticateAdmin = (req, res, next) => {
    const key = req.headers['x-admin-key'] || req.query.adminKey;
    if (!key || key !== ADMIN_KEY) {
        return res.status(401).json({ success: false, error: "Unauthorized Master Admin Key" });
    }
    next();
};

// Middleware: Validate One-Time License Key
const validateLicenseKey = (req, res, next) => {
    const key = req.headers['x-admin-key'];
    
    // Master Admin always bypasses license check
    if (key === ADMIN_KEY) return next();

    if (!key || !licenseStore.has(key)) {
        return res.status(403).json({ success: false, error: "Invalid License Key. Please purchase a valid passkey." });
    }

    const license = licenseStore.get(key);
    if (license.redeemed) {
        return res.status(403).json({ success: false, error: "This license key has already been used." });
    }

    req.licenseKey = key;
    next();
};

// -------------------------------------------------------------
// ADMIN / AUTOMATION API: Generate One-Time License Key
// -------------------------------------------------------------
app.post('/api/admin/generate-key', authenticateAdmin, (req, res) => {
    // Generate a secure random 8-character token (e.g. OOMLY-A1B2C3D4)
    const rawCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const newKey = `OOMLY-${rawCode}`;

    licenseStore.set(newKey, {
        redeemed: false,
        createdAt: new Date()
    });

    console.log(`🎟️ [NEW LICENSE GENERATED]: ${newKey}`);
    res.json({ success: true, licenseKey: newKey });
});

// API: List All Active & Redeemed Keys (For Admin Dashboard)
app.get('/api/admin/keys', authenticateAdmin, (req, res) => {
    const keysList = Array.from(licenseStore.entries()).map(([key, data]) => ({
        key,
        redeemed: data.redeemed,
        createdAt: data.createdAt
    }));
    res.json({ success: true, keys: keysList });
});

// -------------------------------------------------------------
// CLIENT API: Request Pairing Code (Consumes 1-Time License Key)
// -------------------------------------------------------------
app.post('/api/pair', validateLicenseKey, async (req, res) => {
    const { phone, userId } = req.body;
    if (!phone || !userId) {
        return res.status(400).json({ success: false, error: "Phone number is required" });
    }

    const cleanNumber = phone.replace(/[^0-9]/g, '');
    const sessionDir = path.join(__dirname, 'sessions', userId);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Oomly WhatsApp Bot", "Chrome", "1.0.0"]
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection } = update;
            if (connection === 'open') {
                activeConnections[userId] = true;
                
                // Mark License Key as REDEEMED once successfully linked!
                if (req.licenseKey && licenseStore.has(req.licenseKey)) {
                    licenseStore.get(req.licenseKey).redeemed = true;
                    console.log(`🔒 [KEY REDEEMED & EXPIRED]: ${req.licenseKey}`);
                }
            } else if (connection === 'close') {
                activeConnections[userId] = false;
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;
            const from = msg.key.remoteJid;
            const messageId = msg.key.id;

            messageCache.set(messageId, msg);

            // Anti-Delete
            if (msg.message.protocolMessage && msg.message.protocolMessage.type === 0) {
                const deletedKey = msg.message.protocolMessage.key.id;
                const originalMsg = messageCache.get(deletedKey);
                if (originalMsg) {
                    deletedVault.push({
                        id: deletedKey,
                        sender: (originalMsg.key.participant || originalMsg.key.remoteJid).split('@')[0],
                        text: originalMsg.message?.conversation || originalMsg.message?.extendedTextMessage?.text || "[Media]",
                        timestamp: new Date().toLocaleTimeString()
                    });
                }
            }
        });

        if (!sock.authState.creds.registered) {
            setTimeout(async () => {
                const code = await sock.requestPairingCode(cleanNumber);
                return res.json({ success: true, pairingCode: code });
            }, 3000);
        } else {
            activeConnections[userId] = true;
            return res.json({ success: true, pairingCode: "ALREADY_LINKED" });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/status', validateLicenseKey, (req, res) => {
    const { userId } = req.query;
    res.json({ connected: !!activeConnections[userId] });
});

app.get('/api/vault', validateLicenseKey, (req, res) => {
    res.json({ success: true, vault: deletedVault });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Automated Oomly Bot Server active on port ${PORT}`);
});