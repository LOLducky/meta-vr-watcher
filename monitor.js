// Checks a set of Meta Horizon profile IDs for username changes and
// posts a Discord webhook notification when a change is detected.
// Designed to be run periodically (e.g. every 5 min via Windows Task Scheduler).

const fs = require("fs");
const path = require("path");
const https = require("https");

const PROFILES_PATH = path.join(__dirname, "profiles.json");
const STATE_PATH = path.join(__dirname, "state.json");
const LOG_PATH = path.join(__dirname, "monitor.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
        },
        timeout: 20000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
  });
}

function extractUsername(html) {
  const match = html.match(/"vr_name":"((?:\\.|[^"\\])*)"/);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

async function fetchUsername(profileId) {
  const url = `https://horizon.meta.com/profile/${profileId}/`;
  const { statusCode, body } = await httpGet(url);
  if (statusCode !== 200) {
    throw new Error(`Unexpected status ${statusCode} for profile ${profileId}`);
  }
  const username = extractUsername(body);
  if (!username) {
    throw new Error(`Could not find username in page for profile ${profileId}`);
  }
  return username;
}

function sendDiscordMessage(webhookUrl, content) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ content });
    const req = https.request(
      webhookUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 20000,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Discord request timed out")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    log("ERROR: DISCORD_WEBHOOK_URL environment variable is not set.");
    process.exitCode = 1;
    return;
  }

  const profilesConfig = loadJson(PROFILES_PATH, null);
  if (!profilesConfig || !Array.isArray(profilesConfig.profiles)) {
    log("ERROR: profiles.json is missing or malformed.");
    process.exitCode = 1;
    return;
  }

  const state = loadJson(STATE_PATH, {});
  let stateChanged = false;

  for (const profile of profilesConfig.profiles) {
    const { label, profileId } = profile;
    if (!profileId || profileId.startsWith("REPLACE_WITH")) {
      log(`Skipping "${label}" — profileId not set in profiles.json`);
      continue;
    }

    try {
      const currentUsername = await fetchUsername(profileId);
      const previousUsername = state[profileId];

      if (previousUsername === undefined) {
        log(`Baseline for "${label}" (${profileId}): ${currentUsername}`);
        state[profileId] = currentUsername;
        stateChanged = true;
      } else if (previousUsername !== currentUsername) {
        log(
          `CHANGE for "${label}" (${profileId}): ${previousUsername} -> ${currentUsername}`
        );
        await sendDiscordMessage(
          webhookUrl,
          `🔔 **${label}** changed their Meta Horizon username:\n` +
            `\`${previousUsername}\` → \`${currentUsername}\`\n` +
            `<https://horizon.meta.com/profile/${profileId}/>`
        );
        state[profileId] = currentUsername;
        stateChanged = true;
      } else {
        log(`No change for "${label}" (${profileId}): ${currentUsername}`);
      }
    } catch (err) {
      log(`ERROR checking "${label}" (${profileId}): ${err.message}`);
    }
  }

  if (stateChanged) {
    saveJson(STATE_PATH, state);
  }
}

main();
