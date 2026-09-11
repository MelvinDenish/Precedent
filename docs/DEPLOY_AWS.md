# Deploying Precedent on AWS

Three deployable units, one codebase: **web** (static SPA), **api** (stateless,
scales horizontally), **worker** (separate process, scales independently).
Plus Postgres 16 with pgvector, Redis for BullMQ, and blob storage for the
original PDFs that back the citation trail.

Two paths are documented because they trade off differently, and the Docker
artifacts are **identical** for both. Pick at deploy time.

| | Path A — one EC2 box | Path B — EC2 + managed free tiers |
|---|---|---|
| Runs on the box | api, worker, Postgres, Redis, Caddy | api, worker, Caddy |
| Postgres | container on the box | Neon free tier |
| Redis | container on the box | Upstash free tier |
| Cost, year 1 | free | free |
| **Cost, year 2+** | **EC2 free tier expires** | **still free** |
| Failure blast radius | one box loses everything | data survives the box |
| RAM needed | ~1.8 GB (needs swap on t3.micro) | ~700 MB |
| Ops burden | you own backups and upgrades | managed |

**Recommendation: Path B.** The AWS free tier for EC2 and RDS is 12 months
only, while Neon and Upstash free tiers do not expire. Path B is also what
`ARCHITECTURE.md` assumes, and it keeps the database alive when you rebuild
the box. Take Path A only if you want everything inside your own AWS account.

---

## Prerequisites

- An AWS account, and the AWS CLI authenticated (`aws sts get-caller-identity`)
- A domain, or willingness to use the EC2 public DNS name
- `GEMINI_API_KEY` and `GROQ_API_KEY`

---

## Step 1 — Blob storage (S3), both paths

Original PDFs are stored so every citation can point at its source. The API
**never redistributes them**; only extracted question text and citations are
served, so the bucket stays private.

```bash
aws s3api create-bucket \
  --bucket precedent-blobs-<unique-suffix> \
  --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1

aws s3api put-public-access-block \
  --bucket precedent-blobs-<unique-suffix> \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Free tier: 5 GB, 20k GET, 2k PUT per month. The whole seed corpus is ~376 MB.

Create an IAM user with `s3:GetObject`/`s3:PutObject` scoped to that bucket
only, and put its keys in `.env` as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.

---

## Step 2 — The web SPA (S3 + CloudFront), both paths

CloudFront's always-free tier is 1 TB egress and 10M requests per month, which
this will not approach.

```bash
cd web && npm run build          # emits web/dist

aws s3api create-bucket --bucket precedent-web-<suffix> \
  --region ap-south-1 --create-bucket-configuration LocationConstraint=ap-south-1
aws s3 sync dist/ s3://precedent-web-<suffix>/ --delete
```

Create a CloudFront distribution with that bucket as origin, using **Origin
Access Control** so the bucket itself stays private.

**Two settings that are easy to miss:**

1. **SPA routing.** Add a custom error response mapping **403 and 404 → `/index.html`
   with response code 200**. Without it, a deep link like `/subjects/3/atlas`
   returns an S3 404 instead of loading the app.
2. **Never cache `index.html`.** Set `Cache-Control: no-cache` on it and long
   max-age on the hashed assets, or a deploy leaves users on a stale bundle
   pointing at deleted chunk files.

Set `VITE_API_URL` to the API's public origin before building.

---

## Step 3 — Database and Redis

### Path B (recommended)

- **Neon** — create a Postgres 16 project, then run `CREATE EXTENSION vector;`
  once in the SQL editor. Copy the pooled connection string into `DATABASE_URL`.
  Neon **suspends idle compute**, so the first request after a sleep is slow.
  Either point an uptime pinger at `/health` every 5 minutes, or state the
  cold-start delay in the README. Do not let a recruiter's first click be a
  30-second wait.
- **Upstash** — create a Redis database, copy the `rediss://` URL into
  `REDIS_URL`. Use the TLS URL, not the plain one.

### Path A

Postgres and Redis run as containers from `docker-compose.yml`. Nothing extra
to provision — but take backups yourself:

```bash
docker compose exec -T postgres pg_dump -U precedent precedent | gzip > backup-$(date +%F).sql.gz
```

### Upgrade path (paid, when free tiers stop being enough)

**RDS Postgres 16** — `db.t4g.micro` is free-tier eligible for 12 months.
After creating the instance you **must** enable the extension explicitly:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

This is the single most likely deployment blocker. `migrations/001_core.sql`
issues that statement, so `npm run migrate` handles it provided the DB user has
rights to create extensions — the RDS master user does. Confirm your chosen
engine version ships pgvector: `SELECT * FROM pg_available_extensions WHERE name='vector';`

**ElastiCache Redis** — `cache.t3.micro`. Use a **non-clustered** configuration:
BullMQ does not support Redis Cluster mode without careful key-hashing.
MOST IMPORTANT: set the eviction policy to `noeviction`. Any `allkeys-*` policy
will silently discard queued jobs under memory pressure, and you will lose
ingestion work with no error raised.

---

## Step 4 — The EC2 box (api + worker)

### Instance

- **AMI:** Amazon Linux 2023
- **Type:** `t3.micro` (2 vCPU, 1 GB) — 750 hrs/month free for 12 months.
  Path A is tight on 1 GB and **requires swap**; Path B fits comfortably.
- **Storage:** 20 GB gp3 (30 GB is free-tier)
- **Security group inbound:** 22 from your IP only, 80 and 443 from anywhere.
  **Do not open 3000, 5432 or 6379 to the internet.**

### Swap — required for Path A, advisable for both

A t3.micro has 1 GB of RAM. Postgres, Redis, two Node processes and the ONNX
embedding model will not co-exist in that without swap, and the OOM killer
takes the worker mid-job.

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Install and run

```bash
sudo dnf update -y && sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user && newgrp docker
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

git clone https://github.com/MelvinDenish/Precedent.git && cd Precedent
cp .env.example .env && nano .env        # fill in every value; see below
```

**Generate a real JWT secret** — the API refuses to boot without one, by design:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then:

```bash
# Path A — everything on the box
docker compose --profile full up -d --build

# Path B — api and worker only; Postgres and Redis come from Neon/Upstash
docker compose up -d --build api worker
```

Apply migrations once, from the box:

```bash
docker compose run --rm api node -e "process.exit(0)"   # warms the image
npm ci && npm run migrate
```

`docker-compose.yml` already sets restart behaviour and health checks. Add
`restart: unless-stopped` to the api and worker services if you want them to
survive a reboot without a systemd unit.

---

## Step 5 — TLS

Browsers refuse mixed content, so an HTTPS SPA on CloudFront cannot call a
plain-HTTP API. Terminate TLS with Caddy, which obtains and renews a
Let's Encrypt certificate automatically:

```
# /etc/caddy/Caddyfile  (or a caddy service in the compose file)
api.your-domain.com {
    reverse_proxy localhost:3000
}
```

Then set `WEB_ORIGIN=https://your-cloudfront-domain` in `.env` so CORS admits
the SPA — the API restricts CORS to exactly that origin and never uses a
wildcard.

---

## Step 6 — Seed the corpus

The corpus is **not in the repository** and never will be: this repo is public
and `data/` holds copyrighted textbooks alongside the question papers. Copy it
to the box out of band.

```bash
scp -r -i key.pem ./data ec2-user@<host>:~/Precedent/data
ssh -i key.pem ec2-user@<host>
cd Precedent && npm run seed
```

Ingestion is queued, so `seed` returns quickly and the worker processes in the
background. Watch it:

```bash
docker compose logs -f worker
```

**Budget the Gemini quota.** 20 of the 31 papers need vision extraction, at
roughly one call per page. The free tier is ~1,500 requests/day, which covers
the seed comfortably in one run — but if you re-seed repeatedly you will hit
it. The queue defers rather than failing the paper when quota is exhausted,
so exhausting it costs time, not data.

---

## Verification, in order

```bash
curl https://api.your-domain.com/health          # {"ok":true,"dbLatencyMs":N}
```

1. **Health** returns ok, and `dbLatencyMs` is sane (a few hundred ms on Neon
   after a cold start is expected, not a fault).
2. **Idempotency** — upload the same paper 5 times under different filenames.
   Expect exactly 1 `papers` row and 4 contributor credits.
3. **Worker resilience** — `docker compose restart worker` mid-ingest. The job
   resumes from the queue; nothing is lost.
4. **SPA deep link** — open `/subjects` directly in a fresh tab. If you get a
   403 or 404, the CloudFront error-response mapping in Step 2 is missing.
5. **CORS** — the SPA can call the API. A failure here is almost always
   `WEB_ORIGIN` not matching the CloudFront domain exactly, scheme included.

---

## Cost

| Service | Path A | Path B | After 12 months |
|---|---|---|---|
| EC2 t3.micro | free | free | ~$8/mo |
| S3 (blobs + web) | free under 5 GB | free under 5 GB | pennies |
| CloudFront | free under 1 TB | free under 1 TB | free under 1 TB |
| Postgres | on the box | Neon free | Neon still free |
| Redis | on the box | Upstash free | Upstash still free |
| **Total** | **$0** | **$0** | **~$8/mo (A or B)** |

Data transfer out of EC2 is 100 GB/month free account-wide, which this will
not approach.

---

## Teardown

```bash
aws s3 rm s3://precedent-web-<suffix> --recursive
aws s3 rb s3://precedent-web-<suffix>
# delete the CloudFront distribution (disable first, deletion is not immediate)
# terminate the EC2 instance, then delete its EBS volume if it was retained
# delete the Neon project and Upstash database
```

The blob bucket holds the only copy of some uploaded PDFs. Check before
deleting it.
