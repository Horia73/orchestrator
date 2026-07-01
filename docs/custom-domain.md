# Use Your Own HTTPS Domain

Orchestrator's one-click HTTPS setup is DuckDNS-specific. A purchased domain works too, but it is still a manual reverse-proxy setup: point DNS at the machine that runs Orchestrator, terminate HTTPS there, and proxy traffic to the local Orchestrator ports.

Settings -> Remote Access -> HTTPS / public address has an "Own domain" mode that validates whether your public HTTPS domain reaches Orchestrator's `/api/ping` endpoint and then gives you the exact env lines to set. It does not buy the domain, edit DNS, install certificates, or write your host nginx config for you.

Use a subdomain such as `orchestrator.example.com`. It is easier to manage than the root domain and avoids conflicts with your main website.

## What Orchestrator Needs

- `https://orchestrator.example.com` reaches the Orchestrator UI.
- The proxy forwards the app to `127.0.0.1:3000`.
- If live browser view is enabled, the proxy forwards `/vnc/` to `127.0.0.1:6080`.
- `.env` sets `ORCHESTRATOR_PUBLIC_URL=https://orchestrator.example.com`.
- `.env` sets `BROWSER_AGENT_VNC_WS_PUBLIC_URL=wss://orchestrator.example.com/vnc` if you use live browser view.

The Docker install intentionally publishes both internal services on loopback only. Keep that model: expose nginx or your reverse proxy, not the container ports directly.

## DNS Options

Pick one:

- Static public IP: create an `A` record for `orchestrator.example.com` pointing at the server's public IP. Add an `AAAA` record too if you use IPv6.
- Dynamic home IP: create a `CNAME` from `orchestrator.example.com` to an existing dynamic DNS hostname, such as `your-name.duckdns.org`. DuckDNS can stay as the updater while users see your own domain.
- Root domain: if you need `example.com` instead of a subdomain, use your DNS provider's `ALIAS`, `ANAME`, or flattened `CNAME` feature when available. Otherwise use `A` / `AAAA` records.
- Private/VPN-only access: point the name at the LAN/VPN address instead. Google/Gmail OAuth and browser notifications still need the browser to open a valid HTTPS origin, so make sure the device completing setup can resolve and reach the name.

If the server is behind a home router, forward TCP `80` and `443` to the machine running nginx. If you cannot expose port `80`, use a DNS-01 certificate flow through your DNS provider instead of HTTP-01.

## Get a Certificate

For a simple public HTTP-01 setup on Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot
sudo systemctl stop nginx
sudo certbot certonly --standalone -d orchestrator.example.com
```

For Cloudflare, Route 53, DigitalOcean, or another DNS provider, use that provider's DNS-01 plugin or acme.sh integration and issue a certificate for `orchestrator.example.com`. DNS-01 is the better choice when the host is behind strict NAT or port `80` cannot be forwarded.

## Configure nginx

Create `/etc/nginx/sites-available/orchestrator.conf` on Debian/Ubuntu, or `/etc/nginx/conf.d/orchestrator.conf` on systems that do not use `sites-available`.

Replace `orchestrator.example.com` with your hostname:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name orchestrator.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name orchestrator.example.com;

    ssl_certificate /etc/letsencrypt/live/orchestrator.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/orchestrator.example.com/privkey.pem;

    client_max_body_size 100m;

    location /vnc/ {
        proxy_pass http://127.0.0.1:6080/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port 443;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port 443;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Enable and reload it:

```bash
sudo ln -sfn /etc/nginx/sites-available/orchestrator.conf /etc/nginx/sites-enabled/orchestrator.conf
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

Skip the `ln -sfn` command on systems that use `/etc/nginx/conf.d/`.

## Set Orchestrator's Public URL

In the checkout's `.env`:

```bash
ORCHESTRATOR_PUBLIC_URL=https://orchestrator.example.com
BROWSER_AGENT_VNC_WS_PUBLIC_URL=wss://orchestrator.example.com/vnc
```

Then restart Orchestrator so the environment is reloaded.

Docker install:

```bash
docker compose up -d --force-recreate orchestrator
```

Native install:

```bash
sudo systemctl restart orchestrator
```

If your install uses a user service instead of a system service, run the equivalent `systemctl --user restart orchestrator`.

## OAuth Redirects

After changing the public URL, update any OAuth app redirect URIs that need the domain:

```text
https://orchestrator.example.com/api/integrations/google/oauth/callback
https://orchestrator.example.com/api/integrations/gmail/oauth/callback
```

Then reconnect Google Workspace or Gmail from Settings -> Auth if their current credentials were created for a different origin.

## Verify

```bash
curl -I https://orchestrator.example.com
```

Then open Settings -> Remote Access. The HTTPS / public address section should show the custom domain as configured. Browser notifications should be enabled from that HTTPS origin, not from the old localhost or DuckDNS origin.

## Troubleshooting

- Certificate issuance fails: confirm DNS resolves to the public IP and port `80` reaches the host, or switch to DNS-01.
- The page loads but API calls fail: confirm nginx sends `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-Port`.
- Live browser view fails: confirm `/vnc/` proxies to `127.0.0.1:6080` and preserves WebSocket upgrade headers.
- Google OAuth still redirects to localhost: confirm `ORCHESTRATOR_PUBLIC_URL` is set in the running Orchestrator environment and restart the app.
- Cloudflare proxy issues: start with DNS-only records. After it works, enable proxying only if WebSockets and long-running requests are allowed.
