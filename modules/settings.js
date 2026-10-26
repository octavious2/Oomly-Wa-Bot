// modules/settings.js

const botSettings = {
    antiDelete: true,
    viewOnce: true,
    autoStatus: true,
    ghostPresence: true
};

function getSettings() {
    return botSettings;
}

function updateSetting(key, value) {
    if (key in botSettings) {
        botSettings[key] = Boolean(value);
        console.log(`⚙️ [SETTINGS UPDATED]: ${key} set to ${botSettings[key]}`);
        return true;
    }
    return false;
}

module.exports = { getSettings, updateSetting };