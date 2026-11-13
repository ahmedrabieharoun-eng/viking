# VIKING MINER server — Render deploy notes (RTDB version)

Web Service (Node), Frankfurt, Free plan.
- Build Command: `npm install`
- Start Command: `npm start`  (functions-framework --target=collectMining; Render's $PORT is used automatically)
- The server uses Firebase **Realtime Database** via firebase-admin (see PORT_NOTES.md for the Firestore→RTDB mapping).

## Environment variables (Render dashboard → Environment)
- `BOT_TOKEN` — the Telegram bot token (entered by the owner directly in Render, never in chat)
- `OWNER_ID` = `6970148965`
- `ALLOWED_ORIGIN` = `https://ahmedrabieharoun-eng.github.io`
- `FIREBASE_DATABASE_URL` = `https://viking-miner-7e2c8-default-rtdb.firebaseio.com`
- `GOOGLE_APPLICATION_CREDENTIALS` = `/etc/secrets/service-account.json`
- `TONAPI_KEY` — optional, leave unset

## Secret file (Render dashboard → Environment → Secret Files)
- Filename: `service-account.json` → lands at `/etc/secrets/service-account.json`
- Content: the service-account key JSON of the Firebase project `viking-miner-7e2c8` (owner pastes it himself in Render).
  That project has the Realtime Database created (locked mode). Apply `database.rules.json` from this repo to it (locked + indexes).

## Verify after deploy
- POST the service URL with a bogus initData → expect `401 {"error":"Unauthorized"}` (server up, auth layer works; DB is only touched after a valid Telegram login).
- Real check: open the Mini App from the bot; `state` must return the player + settings.

## Notes
- Free Render services sleep after ~15 min idle; first request then takes ~50 s. Add a keep-alive pinger (cron-job.org every 10 min) once live.
- Frontend lives in this same repo (index.html, GitHub Pages); its API_URL must equal this service's URL.
