const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// Load Config from Environment Variables
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change_this_secret_key_123";
const USE_MOCK_MODE = process.env.MOCK_MODE === "true";

// Memory Storage
const activeConnections = {};
const messageCache = new Map();
const deletedVault = [];

// Static Frontend
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Security Middleware: Validate Admin Authorization
const authenticateAdmin = (req, res, next) => {
    const authHeader = req.headers['x-admin-key'] || req.query.adminKey;
    if (!authHeader || authHeader !== ADMIN_KEY) {
        return res.status(401).json({ success: false, error: "Unauthorized: Invalid Admin Key" });
    }
    next();
};

// Handle Session Recovery from Environment Variables (For Cloud Persisting)
const restoreSessionFromEnv = async (userId) => {
    const sessionDir = path.join(__dirname, 'sessions', userId);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    if (process.env.WA_SESSION_DATA) {
        try {
            const rawSession = Buffer.from(process.env.WA_SESSION_DATA, 'base64').toString('utf-8');
            fs.writeFileSync(path.join(sessionDir, 'creds.json'), rawSession);
            console.log('🔒 Restored WhatsApp session from cloud environment secret!');
        } catch (err) {
            console.error('⚠️ Failed to restore session from env:', err.message);
        }
    }
};

// API: Request Pairing Code (Protected)
app.post('/api/pair', authenticateAdmin, async (req, res) => {
    const { phone, userId } = req.body;
    if (!phone || !userId) {
        return res.status(400).json({ success: false, error: "Phone number and User ID are required" });
    }

    const cleanNumber = phone.replace(/[^0-9]/g, '');

    if (USE_MOCK_MODE) {
        console.log(`🧪 [MOCK MODE] Pairing code requested for: ${cleanNumber}`);
        setTimeout(() => res.json({ success: true, pairingCode: "MOCK-8888" }), 1200);
        setTimeout(() => {
            activeConnections[userId] = true;
        }, 6000);
        return;
    }

    try {
        await restoreSessionFromEnv(userId);
        const sessionDir = path.join(__dirname, 'sessions', userId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["WhatsApp Cloud Bot", "Chrome", "1.0.0"]
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            // Export base64 string for persistent storage in cloud environments
            const credsPath = path.join(sessionDir, 'creds.json');
            if (fs.existsSync(credsPath)) {
                const credsRaw = fs.readFileSync(credsPath, 'utf-8');
                const base64Creds = Buffer.from(credsRaw).toString('base64');
                console.log(`\n🔑 [CLOUD SECRET] Copy this string into Render WA_SESSION_DATA env var:\n${base64Creds}\n`);
            }
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                activeConnections[userId] = true;
                console.log(`✅ WhatsApp Bot Connected for: ${userId}`);
            } else if (connection === 'close') {
                activeConnections[userId] = false;
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log('🔄 Session disconnected. Attempting auto-reconnect...');
                }
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const messageId = msg.key.id;

            // 1. Cache message
            messageCache.set(messageId, msg);

            // 2. Anti-Delete Capture
            if (msg.message.protocolMessage && msg.message.protocolMessage.type === 0) {
                const deletedKey = msg.message.protocolMessage.key.id;
                const originalMsg = messageCache.get(deletedKey);
                
                if (originalMsg) {
                    const textContent = originalMsg.message?.conversation || originalMsg.message?.extendedTextMessage?.text || "[Media/Other]";
                    const sender = originalMsg.key.participant || originalMsg.key.remoteJid;
                    
                    deletedVault.push({
                        id: deletedKey,
                        sender: sender.split('@')[0],
                        text: textContent,
                        timestamp: new Date().toLocaleTimeString()
                    });
                }
            }

            // 3. Group Moderation (Anti-Link)
            if (isGroup) {
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
                if (text.includes('chat.whatsapp.com/')) {
                    await sock.sendMessage(from, { delete: msg.key });
                    await sock.sendMessage(from, { text: `⚠️ Links are not allowed in this group!` }, { quoted: msg });
                }
            }

            // 4. AI Commands
            const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            if (body.startsWith('!ai ')) {
                const prompt = body.replace('!ai ', '');
                await sock.sendMessage(from, { text: `🤖 [AI Assistant]: Processing query -> "${prompt}"...` }, { quoted: msg });
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

// API: Get Status (Protected)
app.get('/api/status', authenticateAdmin, (req, res) => {
    const { userId } = req.query;
    res.json({ connected: !!activeConnections[userId] });
});

// API: Fetch Anti-Delete Vault (Protected)
app.get('/api/vault', authenticateAdmin, (req, res) => {
    res.json({ success: true, vault: deletedVault });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Production WhatsApp Bot Server active on port ${PORT}`);
});