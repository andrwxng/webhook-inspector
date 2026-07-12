# Deploying to an Azure VM (GitHub Student Pack)

One small always-on VM runs the whole stack via `docker-compose.prod.yml`:
the app, Postgres, Redis, and Caddy (which gets HTTPS certificates from
Let's Encrypt automatically). CI deploys on every push to `main` by SSHing
in and rebuilding.

## 1. Azure account and VM (~15 min, in the browser)

1. Activate **Azure for Students** at azure.microsoft.com/free/students —
   sign in with the school account tied to your GitHub Student Pack. No
   credit card. You get $100 credit plus 12 months of free services,
   including 750 h/month of a B1s VM (= one VM, always on, free).
2. Portal → **Virtual machines → Create**:
   - Image: **Ubuntu Server 24.04 LTS**
   - Size: **B2ats_v2** (2 vCPU / 1 GiB, AMD) — current free-tier size,
     750 h/month for 12 months; the listed price only applies past that.
     (B1s and the ARM B2pts_v2 are equally free if your region offers them.)
   - Authentication: **SSH public key** — paste yours
     (`cat ~/.ssh/id_ed25519.pub`)
   - Inbound ports: allow **22, 80, 443**
   - Disk: Standard SSD is fine. Everything else: defaults.
3. Note the VM's **public IP**. In the VM's Networking tab, you can later
   restrict port 22 to your own IP (leave 80/443 open to the world).

## 2. DNS

At your registrar (Namecheap — the Student Pack includes a free `.me`
domain), add an **A record** pointing your domain (e.g.
`hooks.yourdomain.me`) at the VM's public IP. Caddy can only obtain a
certificate once the record resolves.

## 3. One-time server setup (~10 min, copy-paste over SSH)

```bash
ssh azureuser@<VM_IP>

# Docker (official convenience script) + let this user run it
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit   # re-login to pick up the group

ssh azureuser@<VM_IP>

# 2 GiB swap — 1 GiB RAM is tight while npm/vite build inside Docker
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# The app, in the path the CI deploy job expects
sudo mkdir -p /opt/webhook-inspector && sudo chown $USER /opt/webhook-inspector
git clone https://github.com/andrwxng/webhook-inspector.git /opt/webhook-inspector
cd /opt/webhook-inspector

# Production config — this .env stays on the server, never in git
cat > .env <<EOF
DOMAIN=hooks.yourdomain.me
POSTGRES_PASSWORD=$(openssl rand -hex 24)
EOF

docker compose -f docker-compose.prod.yml up -d --build
```

First build takes a few minutes on a B1s. Then verify:

```bash
curl https://hooks.yourdomain.me/healthz   # → {"status":"ok"}
```

## 4. Wire up CI deploys

Generate a dedicated deploy key (do NOT reuse your personal key):

```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C "gha-deploy"
ssh azureuser@<VM_IP> 'cat >> ~/.ssh/authorized_keys' < deploy_key.pub
```

In the GitHub repo → Settings → Secrets and variables → Actions, add:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | the VM's public IP |
| `DEPLOY_USER` | `azureuser` |
| `DEPLOY_SSH_KEY` | contents of the private `deploy_key` file |

Delete the local `deploy_key` files afterwards. From then on every green
CI run on `main` redeploys the VM. (The deploy job no-ops while the
secrets are absent, so nothing breaks before the VM exists.)

## 5. Cutover checklist (keep the demo up throughout)

1. New domain serves the app: healthz ok, register, create endpoint,
   `curl -X POST https://hooks.yourdomain.me/in/<slug>` appears live.
2. GitHub OAuth (if used): update the OAuth app's callback URL to the new
   domain and put `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` in the
   server's `.env`, then `docker compose -f docker-compose.prod.yml up -d`.
3. Update the README's live-demo link + resume link to the new domain.
4. Only then delete the Railway services.

## Day-2 notes

- **Logs:** `docker compose -f docker-compose.prod.yml logs -f app`
- **Backups:** `docker compose -f docker-compose.prod.yml exec postgres pg_dump -U webhook webhook_inspector | gzip > backup.sql.gz` (cron it weekly; demo data is low-stakes)
- **OS updates:** `sudo apt update && sudo apt upgrade -y` occasionally; Ubuntu's unattended-upgrades handles security patches by default.
