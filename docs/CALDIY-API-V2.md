# Deploying Cal API v2 for a self-hosted Cal.diy

This MCP server talks to **Cal API v2**. On a self-hosted Cal.diy (or Cal.com) instance, API v2 is **not part of
the web app**: it is a separate NestJS service in the same repository (`apps/api/v2`) that needs its own container and a
Redis instance. Cal.diy has no API v1, so without API v2 there is no API at all. The symptom is simple:
`https://your-cal.example.com/api/v2/me` returns the web app's HTML 404 page, and the MCP's `get_instance_info` says
"this URL serves a web page, not Cal API v2".

```
Internet ── nginx (cal.example.com) ──┬── /          → 127.0.0.1:3000  calcom      (web app)
                                      └── /api/v2/   → 127.0.0.1:5555  calcom-api  (API v2) ──► calcom-redis
                                                                        └── same PostgreSQL database as the web app
```

TechMavie's own deployment notes live in the Cal.diy fork (`techmavie/API-V2.md`); this page is the generic version.

## 1. Build the API v2 image

No upstream workflow publishes an API v2 image, so build it from the same commit as your web image:

```bash
git clone https://github.com/calcom/cal.diy.git && cd cal.diy
docker build -f apps/api/v2/Dockerfile -t cal-diy-api:latest .
```

The build installs the whole monorepo (expect 30–90 minutes and 8–12 GB of RAM). A GitHub Actions job on a
standard runner works well; see `.github/workflows/techmavie-build-api-image.yml` in the TechMavie fork for a
ready-made one that pushes to GHCR.

### Redis TLS in production

`apps/api/v2/src/app.module.ts` appends `?tls=true` to `REDIS_URL` for the Bull queue whenever
`NODE_ENV=production`, so a plain Redis container fails the TLS handshake. Either:

- **patch at build time** (what the TechMavie workflow does): make TLS opt-in with
  `sed -i 's/process.env.NODE_ENV === "production" ? "?tls=true" : ""/process.env.REDIS_TLS === "true" ? "?tls=true" : ""/' apps/api/v2/src/app.module.ts`
  before `docker build`, or
- **keep the stock image** and end the URL with `#`: `REDIS_URL=redis://calcom-redis:6379#`. The appended
  `?tls=true` then lands in the URL fragment, which the Redis clients ignore.

## 2. Add the services to your Cal compose file

Reuse the web app's `.env` (`env_file`) so the API has the same database, `NEXTAUTH_SECRET`,
`CALENDSO_ENCRYPTION_KEY` (it decrypts calendar and app credentials), SMTP and calendar app settings — bookings made
through the API then send the same emails and create the same calendar events as bookings made in the browser.
Adjust the network and database names to match your compose file.

```yaml
services:
  calcom-redis:
    image: redis:7-alpine
    restart: always
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - calcom-redis-data:/data
    networks:
      - stack

  calcom-api:
    image: cal-diy-api:latest            # or ghcr.io/<you>/cal.diy-api:sha-<commit>
    restart: always
    env_file: .env
    environment:
      - NODE_ENV=production
      - API_PORT=80
      - API_URL=https://cal.example.com/api        # public base; the API adds /v2
      - WEB_APP_URL=https://cal.example.com
      - DATABASE_READ_URL=${DATABASE_URL}
      - DATABASE_WRITE_URL=${DATABASE_URL}
      - REDIS_URL=redis://calcom-redis:6379        # add a trailing "#" when using the stock image
      - JWT_SECRET=${CAL_API_JWT_SECRET}           # openssl rand -hex 32
      - API_KEY_PREFIX=cal_                        # must match the web app (default cal_)
      - STRIPE_API_KEY=sk_test_unused              # required at startup, unused without Stripe billing
      - STRIPE_WEBHOOK_SECRET=whsec_unused
      - IS_E2E=false
      - LOG_LEVEL=warn
      # - ENABLE_SLOTS_WORKERS=false               # saves memory on small servers
    ports:
      - "127.0.0.1:5555:80"                        # localhost only — nginx is the public entry point
    depends_on:
      - calcom-redis
    mem_limit: 1g
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:80/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    networks:
      - stack

volumes:
  calcom-redis-data:
```

Do not publish the API on `0.0.0.0` (the upstream compose example does) — keep it behind nginx.

## 3. Route `/api/v2/` to it in nginx

Inside the `server { }` block of your Cal domain. No new DNS name or certificate is needed: API v2 rewrites
`/api/v2/*` to `/v2/*` by itself (`REWRITE_API_V2_PREFIX`, on by default).

```nginx
location /api/v2/ {
    proxy_pass http://127.0.0.1:5555;      # no URI part, so the /api/v2 prefix is passed through
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    client_max_body_size 10m;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Create an API key and verify

1. In Cal: **Settings → Developer → API Keys → New API key**. Keys look like `cal_` + 32 hex characters.
2. Check the API:

   ```bash
   curl -s https://cal.example.com/api/v2/me -H "Authorization: Bearer cal_YOUR_KEY"
   ```

   Expected: `{"status":"success","data":{"id":…,"username":…}}`. An HTML page means nginx is not routing
   `/api/v2/` yet; `{"status":"error",…"Your api key is not valid"}` means the key or `API_KEY_PREFIX` is wrong.
3. Connect the MCP with API URL `https://cal.example.com/api/v2` (or just `https://cal.example.com` — the MCP adds
   `/api/v2`) and run `get_instance_info`.

## Keeping web and API in step

Both images must come from the same Cal.diy commit (they share the database schema). After updating your fork,
deploy both together and pin the same `sha-…` tag when you need to roll back:

```bash
docker compose pull calcom calcom-api && docker compose up -d calcom calcom-api
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `IoRedis` / Bull TLS errors in the API logs | Redis TLS forced in production — apply the build patch or the trailing `#` (above) |
| `Missing environment variable: …` at startup | Add it — API v2 requires `JWT_SECRET`, `NEXTAUTH_SECRET`, `REDIS_URL`, `DATABASE_READ_URL`, `DATABASE_WRITE_URL`, `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET` |
| `401 … Your api key is not valid` | Wrong key, or `API_KEY_PREFIX` differs between web and API |
| API bookings send no emails / no Google Calendar event | The API container is missing the web `.env` (`CALENDSO_ENCRYPTION_KEY`, `EMAIL_*`, calendar app credentials) |
| `404 Cannot GET /v2/…` (JSON) | Wrong `cal-api-version` header for a versioned endpoint (the MCP sends the right one) or an older Cal version |
| nginx returns the web app's 404 page | The `location /api/v2/` block is not active — check `nginx -t` and reload |
| High memory use | `ENABLE_SLOTS_WORKERS=false` and a `mem_limit` |
