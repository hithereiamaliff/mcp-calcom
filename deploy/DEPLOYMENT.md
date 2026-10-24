# Cal.com MCP — VPS Deployment Guide

Target: `https://mcp.techmavie.digital/calcom/` → nginx → `127.0.0.1:8102` → container `mcp-calcom:8080`.

```
Client ──HTTPS──► nginx (/calcom/) ──► 127.0.0.1:8102 ──► container :8080
                                                  │
                     mcp-network (external) ◄─────┤
                            │                     ▼
                 mcp-key-service:8090     Cal API v2 (https://book.techmavie.digital/api/v2)
```

**Prerequisite:** the Cal instance must expose API v2 — see [docs/CALDIY-API-V2.md](../docs/CALDIY-API-V2.md).
Without it every tool fails with "this URL serves a web page, not Cal API v2".

## Auth Modes

| Mode | Endpoint | Client auth |
|------|----------|-------------|
| Hosted key-service | `/calcom/mcp/usr_...` | none (key in path) |
| Hosted, query form | `/calcom/mcp?api_key=usr_...` | none |
| Hosted, header form | `/calcom/mcp` | `Authorization: Bearer usr_...` |
| Self-hosted | `/calcom/mcp` | `X-API-Key` + `X-Calcom-Api-Key` (+ `X-Calcom-Api-Url`, `X-Calcom-Access`) |

## Required Environment

`/opt/mcp-servers/calcom/.env` (start from `.env.sample`):

| Variable | Value |
|----------|-------|
| `HOST_PORT` | `8102` on mcp.techmavie.digital (8100 = mcp-forgejo, 8101 taken). Check with `sudo ss -ltnp \| grep 8102` |
| `MCP_API_KEY` | `openssl rand -hex 32` |
| `KEY_SERVICE_URL` | `http://mcp-key-service:8090/internal/resolve` |
| `KEY_SERVICE_TOKEN` | same token as `calcom:<token>` in the key service |
| `PUBLIC_BASE_PATH` | `/calcom` |
| `FIREBASE_CREDENTIALS_DIR` | directory containing `firebase-service-account.json` (optional; same as the other MCPs) |

## Deployment Steps

### 1. Register the server with mcp-key-service

The `calcom` connector ships in mcp-key-service (`src/connectors.ts`). Give this server a token:

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
sudo nano /opt/mcp-key-service/.env      # append ,calcom:<TOKEN> to INTERNAL_SERVER_TOKENS
cd /opt/mcp-key-service && docker compose up -d --force-recreate mcp-key-service
```

### 2. Prepare the checkout

```bash
sudo mkdir -p /opt/mcp-servers/calcom
cd /opt/mcp-servers/calcom
git clone https://github.com/hithereiamaliff/mcp-calcom.git .
cp .env.sample .env && nano .env         # MCP_API_KEY, KEY_SERVICE_URL, KEY_SERVICE_TOKEN, …
docker network inspect mcp-network >/dev/null 2>&1 || docker network create mcp-network
```

### 3. Start the container

```bash
docker compose up -d --build
docker compose logs -f --tail=50
```

> **Never use `--remove-orphans` here, and keep `name: mcp-calcom` in `docker-compose.yml`.** Compose names a
> project after its folder. Without the explicit name this stack would be "calcom", like Cal.diy in `/opt/calcom`,
> and removing orphans in either folder deletes the other stack's containers. The first deploy took Cal.diy down
> that way.

### 4. Configure nginx

Add the `location /calcom/` block from `deploy/nginx-mcp.conf` to the `mcp.techmavie.digital` server block, then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 5. GitHub Actions

Repository secrets: `VPS_HOST`, `VPS_USERNAME`, `VPS_SSH_KEY`, `VPS_PORT` (the old `GH_TOKEN` / `NPM_TOKEN` from the
upstream fork are no longer used). Every push to `main` first runs typecheck, unit tests and the e2e smoke test,
then fetches + resets the VPS checkout, rebuilds and waits for `/health`. The deploy refuses to run if `.env` is missing.

## Verification Sequence

```bash
BASE=https://mcp.techmavie.digital/calcom
LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
H=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
```

1. Health — `keyService` should be `configured`:
   ```bash
   curl -s $BASE/health
   ```
2. Server card:
   ```bash
   curl -s $BASE/.well-known/mcp/server-card.json
   ```
3. Missing auth → `401 missing_auth`:
   ```bash
   curl -s -X POST $BASE/mcp "${H[@]}" -d "$LIST"
   ```
4. Invalid user key → `403 invalid_key`:
   ```bash
   curl -s -X POST $BASE/mcp/usr_00000000000000000000000000000000 "${H[@]}" -d "$LIST"
   ```
5. Hosted path mode (real key from the portal) — 17 / 28 / 39 tools depending on the access level:
   ```bash
   curl -s -X POST $BASE/mcp/usr_YOUR_KEY "${H[@]}" -d "$LIST"
   ```
6. Hosted query and header modes:
   ```bash
   curl -s -X POST "$BASE/mcp?api_key=usr_YOUR_KEY" "${H[@]}" -d "$LIST"
   curl -s -X POST $BASE/mcp "${H[@]}" -H "Authorization: Bearer usr_YOUR_KEY" -d "$LIST"
   ```
7. Self-hosted header mode:
   ```bash
   curl -s -X POST $BASE/mcp "${H[@]}" -H "X-API-Key: $MCP_API_KEY" \
     -H "X-Calcom-Api-Key: cal_YOUR_KEY" -H "X-Calcom-Api-Url: https://book.techmavie.digital/api/v2" -d "$LIST"
   ```
8. A real call through the hosted key:
   ```bash
   curl -s -X POST $BASE/mcp/usr_YOUR_KEY "${H[@]}" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_instance_info","arguments":{}}}'
   ```
9. Analytics protection — `401` without the key, `200` with it:
   ```bash
   curl -s $BASE/analytics
   curl -s $BASE/analytics -H "X-API-Key: $MCP_API_KEY"
   ```

## Useful Commands

```bash
docker compose ps
docker compose logs -f mcp-calcom
docker compose restart mcp-calcom
docker exec mcp-calcom wget -qO- http://mcp-key-service:8090/health   # network check
```

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Tools fail with "serves a web page, not Cal API v2" | API v2 is not deployed / not routed at the connection's API URL — see docs/CALDIY-API-V2.md |
| `503 service_unavailable` on hosted URLs | Key service unreachable or token rejected — check `KEY_SERVICE_URL` (must end in `/internal/resolve`), `KEY_SERVICE_TOKEN`, and that both containers are on `mcp-network` |
| `403 invalid_key` for a fresh key | Key revoked/suspended, or `calcom` missing from `INTERNAL_SERVER_TOKENS` (recreate the key service after editing) |
| `400 invalid_config … private or internal address` | The API URL resolves to a private IP. Use the public URL, or add the hostname to `ALLOW_PRIVATE_CALCOM_HOSTS` |
| Tool errors `401` from Cal | The Cal API key is invalid, expired or deleted — create a new one in Cal → Settings → Developer → API Keys |
| Tool errors `429` | Cal allows ~120 requests per minute per API key; the server retries short waits automatically |
| `405` on GET | Expected — the endpoint is stateless and only accepts POST |
