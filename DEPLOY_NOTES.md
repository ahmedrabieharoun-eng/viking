# VIKING MINER server — Render deploy notes

Web Service (Node), Frankfurt, Free plan.
- Build Command: `npm install`
- Start Command: `npm start`  (functions-framework --target=collectMining; Render's $PORT is used automatically)

## Environment variables (Render dashboard → Environment)
- `BOT_TOKEN` — the Telegram bot token (entered by the owner directly in Render, never in chat)
- `OWNER_ID` = `6970148965`
- `ALLOWED_ORIGIN` = `https://ahmedrabieharoun-eng.github.io`
- `GOOGLE_APPLICATION_CREDENTIALS` = `/etc/secrets/service-account.json`
- `TONAPI_KEY` — optional, leave unset

## Secret file (Render dashboard → Environment → Secret Files)
- Filename: `service-account.json` → lands at `/etc/secrets/service-account.json`
- Content: the Firebase project's service-account key JSON (owner pastes it himself in Render).
  The project must have a Firestore database created (production mode).

## Verify after deploy
- POST the service URL with a bogus initData → expect `401 {"error":"Unauthorized"}` (means the server is up and the auth layer works; Firestore is only touched after a valid Telegram login).
- Real check: open the Mini App from the bot; `state` must return the player + settings.

## Notes
- Free Render services sleep after ~15 min idle; first request then takes ~50 s. Add a keep-alive pinger (cron-job.org every 10 min) once live.
- Frontend lives in the GitHub repo `viking` (GitHub Pages); its API_URL must equal this service's URL.
