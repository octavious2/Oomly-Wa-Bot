const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "owner_secret_123";

// Comma-separated list of valid customer license keys from Render env (e.g., "PASS-ALICE-123,PASS-BOB-456")
const getValidLicenses = () => {
    const raw = process.env.LICENSED_TOKENS || "";
    return raw.split(',').map(k => k.trim()).filter(Boolean);
};

const activeConnections = {};
const messageCache = new Map();
const deletedVault = [];

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware: Master Admin Only
const authenticateAdmin = (req, res, next) => {
    const key = req.headers['x-admin-key'];
    if (!key || key !== ADMIN_KEY) {
        return res.status(401).json({ success: false, error: "Unauthorized Master Admin Key" });
    }
    next();
};

// Middleware: Customer License or Master Admin
const authenticateClientOrAdmin = (req, res, next) => {
    const key = req.headers['x-admin-key'];
    if (key === ADMIN_KEY) return next(); // You have access to everything

    const validLicenses = getValidLicenses();
    if (validLicenses.includes(key)) {
        return next(); // Valid paying customer
    }

    return res.status(403).json({ success: false, error: "Invalid or Unpaid License Key. Please contact admin." });
};

// API: Request Pairing Code (Accessible by Paying Customers using their License Key)
app.post('/api/pair', authenticateClientOrAdmin, async (req, res) => {
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
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                activeConnections[userId] = true;
                console.log(`✅ Bot Connected for user: ${userId}`);
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

            // Anti-Link Moderation in groups
            if (from.endsWith('@g.us')) {
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
                if (text.includes('chat.whatsapp.com/')) {
                    await sock.sendMessage(from, { delete: msg.key });
                    await sock.sendMessage(from, { text: `⚠️ Links are not allowed here!` }, { quoted: msg });
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

app.get('/api/status', authenticateClientOrAdmin, (req, res) => {
    const { userId } = req.query;
    res.json({ connected: !!activeConnections[userId] });
});

app.get('/api/vault', authenticateClientOrAdmin, (req, res) => {
    res.json({ success: true, vault: deletedVault });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Oomly Bot Server active on port ${PORT}`);
});