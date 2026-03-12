require('dotenv').config();
const express = require('express');
const passport = require('passport');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const net = require('net');
const DiscordStrategy = require('passport-discord').Strategy;
const session = require('express-session');

const app = express();

// Avatar cache directory (local copy so avatars are available even if player offline)
const AVATAR_DIR = path.join(__dirname, 'public', 'images', 'avatars');
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
const fsp = fs.promises;

// Ensure avatar is cached locally; returns a path usable in <img src="...">
async function ensureAvatar(minecraftName) {
  try {
    const safe = encodeURIComponent(minecraftName).replace(/%/g, '_');
    const filename = `${safe}.png`;
    const abs = path.join(AVATAR_DIR, filename);
    if (fs.existsSync(abs)) return `/images/avatars/${filename}`;
    // fetch from mc-heads.net and store
    const url = `https://mc-heads.net/avatar/${encodeURIComponent(minecraftName)}/64`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(abs, buf);
    return `/images/avatars/${filename}`;
  } catch (e) {
    // fallback to remote URL if anything goes wrong
    return `https://mc-heads.net/avatar/${encodeURIComponent(minecraftName)}/64`;
  }
}

// Middleware
app.use(express.static('public'));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// Passport Discord Strategy
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL,
  scope: ['identify', 'email']
}, (accessToken, refreshToken, profile, done) => {
  // Here you can save user to database or just use profile
  return done(null, profile);
}));

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// Routes
app.get('/', (req, res) => {
  const serverIp = process.env.SERVER_IP || process.env.BIND_ADDRESS || 'play.scburger.fun';
  res.render('index', { user: req.user, serverIp });
});

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => {
    // Successful authentication, redirect home.
    res.redirect('/');
  }
);

app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

// Middleware to check if user is authenticated
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/');
}

// Example protected route
app.get('/profile', isAuthenticated, (req, res) => {
  res.json(req.user);
});

// Helper: format seconds into human readable string
function formatSeconds(s){
  s = Number(s) || 0;
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин`;
  return `${s} с`;
}

// /online - render server-wide statistics
app.get('/online', async (req, res) => {
  // If a plugin DB is available (PLUGIN_DB_PATH), prefer querying it for live stats.
  const PLUGIN_DB_PATH = process.env.PLUGIN_DB_PATH || null;
  let pluginDb = null;
  if (PLUGIN_DB_PATH && fs.existsSync(PLUGIN_DB_PATH)) {
    try { pluginDb = new sqlite3.Database(PLUGIN_DB_PATH); } catch (e) { console.error('failed to open plugin DB', e); pluginDb = null; }
  }

  // local online DB (stores transient online state)
  const DATA_DIR = path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const ONLINE_DB_PATH = path.join(DATA_DIR, 'online.db');
  let onlineDb = null;
  try {
    onlineDb = new sqlite3.Database(ONLINE_DB_PATH);
    onlineDb.run('CREATE TABLE IF NOT EXISTS online_players (minecraft_name TEXT PRIMARY KEY, minecraft_uuid TEXT, online INTEGER DEFAULT 0, updated_at INTEGER)');
  } catch (e) { console.error('failed to open/create online db', e); }

  // helper to ensure table exists
  function ensureOnlineTable() { if (!onlineDb) return; onlineDb.run('CREATE TABLE IF NOT EXISTS online_players (minecraft_name TEXT PRIMARY KEY, minecraft_uuid TEXT, online INTEGER DEFAULT 0, updated_at INTEGER)'); }

  if (pluginDb) {
    // Query plugin DB for aggregated stats and top players
    pluginDb.get('SELECT SUM(play_time_seconds) as total_play_time, SUM(deaths) as total_deaths, SUM(player_kills) as total_player_kills, SUM(mob_kills) as total_mob_kills, SUM(blocks_broken) as total_blocks_broken, SUM(blocks_placed) as total_blocks_placed, SUM(items_crafted) as total_items_crafted, SUM(walked_meters) as total_walked_meters, SUM(chat_messages) as total_chat_messages, SUM(achievements) as total_achievements FROM stats', [], (err, summaryRow) => {
      if (err) { console.error('stats query error', err); return res.status(500).send('query error'); }
      pluginDb.all('SELECT minecraft_name, play_time_seconds as total_play_time, deaths, player_kills, mob_kills, blocks_broken FROM stats ORDER BY play_time_seconds DESC LIMIT 50', [], (err2, rows) => {
        if (err2) { console.error('top players query', err2); return res.status(500).send('query error'); }
        // fetch server-level stats (current and max online)
        pluginDb.get('SELECT v FROM server_stats WHERE k = ?', ['max_online'], (err3, maxRow) => {
          if (err3) console.error('server_stats max_online', err3);
          pluginDb.get('SELECT v FROM server_stats WHERE k = ?', ['current_online'], (err4, curRow) => {
            if (err4) console.error('server_stats current_online', err4);
            const maxOnline = maxRow && maxRow.v ? parseInt(maxRow.v || '0') : 0;
            const curOnline = curRow && curRow.v ? parseInt(curRow.v || '0') : 0;
            // perform a quick TCP check to see if the Minecraft server port is reachable
            const mcHost = process.env.MC_HOST || '127.0.0.1';
            const mcPort = Number(process.env.MC_PORT || '25565');
            const checkTcp = (host, port, timeout = 1200) => new Promise((resolve) => {
              const socket = new net.Socket();
              let done = false;
              socket.setTimeout(timeout);
              socket.once('connect', () => { done = true; socket.destroy(); resolve(true); });
              socket.once('timeout', () => { if (!done) { done = true; socket.destroy(); resolve(false); } });
              socket.once('error', () => { if (!done) { done = true; socket.destroy(); resolve(false); } });
              socket.connect(port, host);
            });

            checkTcp(mcHost, mcPort, 1200).then(isServerUp => {
              ensureOnlineTable();
              if (!onlineDb) {
                // no transient online DB; mark all as offline but still ensure avatars are cached
                (async () => {
                  try {
                    let annotated = (rows || []).map(r => (Object.assign({}, r, { isOnline: false })));
                    // cache avatars
                    annotated = await Promise.all((annotated || []).map(async (r) => {
                      r.avatar = await ensureAvatar(r.minecraft_name);
                      return r;
                    }));
                    annotated.sort((a,b) => (b.total_play_time || 0) - (a.total_play_time || 0));
                    return res.render('online', { user: req.user, summary: summaryRow, topPlayers: annotated, maxOnline, curOnline, isServerUp, formatSeconds });
                  } catch (e) {
                    console.error('avatar caching error', e);
                    let annotated = (rows || []).map(r => (Object.assign({}, r, { isOnline: false })));
                    annotated.sort((a,b) => (b.total_play_time || 0) - (a.total_play_time || 0));
                    return res.render('online', { user: req.user, summary: summaryRow, topPlayers: annotated, maxOnline, curOnline, isServerUp, formatSeconds });
                  }
                })();
                return;
              }
              onlineDb.all('SELECT minecraft_name FROM online_players WHERE online = 1', [], (er, onlineRows) => {
                (async () => {
                  try {
                    const onlineSet = new Set((onlineRows || []).map(r => r.minecraft_name));
                    let annotated = (rows || []).map(r => (Object.assign({}, r, { isOnline: onlineSet.has(r.minecraft_name) })));
                    // cache avatars
                    annotated = await Promise.all((annotated || []).map(async (r) => { r.avatar = await ensureAvatar(r.minecraft_name); return r; }));
                    annotated.sort((a,b) => (b.total_play_time || 0) - (a.total_play_time || 0));
                    res.render('online', { user: req.user, summary: summaryRow, topPlayers: annotated, maxOnline, curOnline, isServerUp, formatSeconds });
                  } catch (e) {
                    console.error('avatar caching error', e);
                    const onlineSet = new Set((onlineRows || []).map(r => r.minecraft_name));
                    let annotated = (rows || []).map(r => (Object.assign({}, r, { isOnline: onlineSet.has(r.minecraft_name) })));
                    annotated.sort((a,b) => (b.total_play_time || 0) - (a.total_play_time || 0));
                    res.render('online', { user: req.user, summary: summaryRow, topPlayers: annotated, maxOnline, curOnline, isServerUp, formatSeconds });
                  }
                })();
              });
            }).catch(() => {
              ensureOnlineTable();
              onlineDb.all('SELECT minecraft_name FROM online_players WHERE online = 1', [], (er, onlineRows) => {
                (async () => {
                  try {
                    const onlineSet = new Set((onlineRows || []).map(r => r.minecraft_name));
                    let annotated = (rows || []).map(r => (Object.assign({}, r, { isOnline: onlineSet.has(r.minecraft_name) })));
                    annotated = await Promise.all((annotated || []).map(async (r) => { r.avatar = await ensureAvatar(r.minecraft_name); return r; }));
                    annotated.sort((a,b) => (b.total_play_time || 0) - (a.total_play_time || 0));
                    res.render('online', { user: req.user, summary: summaryRow, topPlayers: annotated, maxOnline, curOnline, isServerUp: false, formatSeconds });
                  } catch (e) {
                    console.error('avatar caching error', e);
                    const onlineSet = new Set((onlineRows || []).map(r => r.minecraft_name));
                    let annotated = (rows || []).map(r => (Object.assign({}, r, { isOnline: onlineSet.has(r.minecraft_name) })));
                    annotated.sort((a,b) => (b.total_play_time || 0) - (a.total_play_time || 0));
                    res.render('online', { user: req.user, summary: summaryRow, topPlayers: annotated, maxOnline, curOnline, isServerUp: false, formatSeconds });
                  }
                })();
              });
            });
          });
        });
      });
    });
    return;
  }

  // Fallback: try simple JSON file data if plugin DB not configured
  try {
    const dataFile = path.join(__dirname, 'data', 'stats.json');
    let data = null;
    if (fs.existsSync(dataFile)) data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const topPlayers = (data && data.topPlayers) || [];
    if (topPlayers && topPlayers.sort) topPlayers.sort((a,b) => (b.total_play_time || b.play_time_seconds || 0) - (a.total_play_time || a.play_time_seconds || 0));
    const summary = (data && data.summary) || {};
    const isServerUp = data && data.isServerUp;
    const curOnline = (data && data.curOnline) || 0;
    const maxOnline = (data && data.maxOnline) || 0;
    // ensure avatars cached for fallback data
    (async () => {
      try {
        const annotated = await Promise.all((topPlayers || []).map(async (p) => {
          p.avatar = await ensureAvatar(p.minecraft_name || p.name || p.player || 'unknown');
          return p;
        }));
        res.render('online', { user: req.user, topPlayers: annotated, summary, isServerUp, curOnline, maxOnline, formatSeconds });
      } catch (e) {
        console.error('avatar caching error (fallback)', e);
        res.render('online', { user: req.user, topPlayers, summary, isServerUp, curOnline, maxOnline, formatSeconds });
      }
    })();
  } catch (e) {
    console.error('failed to render /online', e);
    res.render('online', { user: req.user, topPlayers: [], summary: {}, isServerUp: false, curOnline:0, maxOnline:0, formatSeconds });
  }
});

// /stats/:player - render per-player stats
app.get('/stats/:player', async (req, res) => {
  try {
    const playerName = req.params.player;
    const safe = encodeURIComponent(playerName).replace(/%/g,'_');
    const playerFile = path.join(__dirname, 'data', 'players', `${safe}.json`);
    let player = null;
    if (fs.existsSync(playerFile)) {
      player = JSON.parse(fs.readFileSync(playerFile,'utf8'));
    } else {
      // minimal placeholder player object
      player = {
        minecraft_name: playerName,
        play_time_seconds: 0,
        deaths: 0,
        player_kills: 0,
        mob_kills: 0,
        blocks_broken: 0,
        blocks_placed: 0,
        items_crafted: 0,
        walked_meters: 0,
        chat_messages: 0
      };
    }
    const isOnline = false;
    // ensure avatar cached for player page
    try {
      const avatar = await ensureAvatar(player.minecraft_name || playerName);
      res.render('player_stats', { user: req.user, player, isOnline, avatar });
    } catch (e) {
      console.error('avatar caching error (player page)', e);
      res.render('player_stats', { user: req.user, player, isOnline });
    }
  } catch (e) {
    console.error('failed to render player stats', e);
    res.status(500).send('Server error');
  }
});

// 404 handler - render custom 404 page for unknown routes
app.use((req, res) => {
  res.status(404).render('404', { user: req.user, url: req.originalUrl });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port " + PORT);
});

