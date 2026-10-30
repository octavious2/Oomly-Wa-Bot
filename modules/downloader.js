/**
 * Oomly Technologies - Cloud Media Downloader Engine
 * Extracts YouTube & Spotify links using system yt-dlp & ffmpeg binaries.
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const logger = pino({ level: 'info' });
const TEMP_DIR = path.join(__dirname, '../temp');

// Ensure temporary download buffer directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Execute command line utilities safely with Promise wrappers
 */
function runCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
            if (error) return reject(error);
            resolve(stdout ? stdout.trim() : stderr);
        });
    });
}

/**
 * Download YouTube link as MP3 Audio or MP4 Video
 */
async function downloadYouTube(url, format = 'audio') {
    const timestamp = Date.now();
    const outputFilename = `yt_${timestamp}.${format === 'audio' ? 'mp3' : 'mp4'}`;
    const outputPath = path.join(TEMP_DIR, outputFilename);

    let cmd = '';
    if (format === 'audio') {
        // Extract best audio and convert to standard MP3
        cmd = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${outputPath}" "${url}"`;
    } else {
        // Extract combined video/audio under 50MB (suitable for WhatsApp limit)
        cmd = `yt-dlp -f "bestvideo[ext=mp4][filesize<40M]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${outputPath}" "${url}"`;
    }

    logger.info(`⏳ [DOWNLOADER]: Executing YouTube extraction for format: ${format}`);
    await runCommand(cmd);

    if (!fs.existsSync(outputPath)) {
        throw new Error("File output failed to write to buffer directory.");
    }

    return outputPath;
}

/**
 * Download Spotify tracks by searching matching metadata on YouTube
 */
async function downloadSpotify(url) {
    const timestamp = Date.now();
    const outputFilename = `spotify_${timestamp}.mp3`;
    const outputPath = path.join(TEMP_DIR, outputFilename);

    // yt-dlp automatically parses Spotify metadata and pulls matching track audio from YouTube
    const cmd = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${outputPath}" "${url}"`;

    logger.info(`⏳ [DOWNLOADER]: Resolving Spotify track metadata...`);
    await runCommand(cmd);

    if (!fs.existsSync(outputPath)) {
        throw new Error("Failed to extract Spotify track stream.");
    }

    return outputPath;
}

/**
 * Main command router for Media Downloader
 */
async function handleMediaDownloader(sock, msg) {
    if (!msg || !msg.message) return;

    // Extract text payload
    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || "";

    if (!text) return;

    const remoteJid = msg.key.remoteJid;
    const isYtAudio = text.startsWith('.yta ') || text.startsWith('.song ');
    const isYtVideo = text.startsWith('.ytv ') || text.startsWith('.video ');
    const isSpotify = text.includes('open.spotify.com/track/');

    if (!isYtAudio && !isYtVideo && !isSpotify) return;

    let targetUrl = text.split(' ')[1] || text;
    let filePath = null;

    try {
        await sock.sendMessage(remoteJid, { text: "⏳ *Oomly Downloader:* Processing link... Please wait." }, { quoted: msg });

        if (isYtAudio) {
            filePath = await downloadYouTube(targetUrl, 'audio');
            await sock.sendMessage(remoteJid, {
                audio: { url: filePath },
                mimetype: 'audio/mp4',
                ptt: false
            }, { quoted: msg });
        } else if (isYtVideo) {
            filePath = await downloadYouTube(targetUrl, 'video');
            await sock.sendMessage(remoteJid, {
                video: { url: filePath },
                caption: "🎬 *Downloaded via Oomly Media Engine*"
            }, { quoted: msg });
        } else if (isSpotify) {
            filePath = await downloadSpotify(targetUrl);
            await sock.sendMessage(remoteJid, {
                audio: { url: filePath },
                mimetype: 'audio/mp4',
                ptt: false
            }, { quoted: msg });
        }

    } catch (err) {
        logger.error({ err: err.message }, "❌ [DOWNLOADER ERROR]");
        await sock.sendMessage(remoteJid, { text: `❌ *Download Failed:* ${err.message}` }, { quoted: msg });
    } finally {
        // Clean up temporary files to keep Codespace storage light
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
}

module.exports = { handleMediaDownloader };