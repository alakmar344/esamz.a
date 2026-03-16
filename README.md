# esamz.a

## MongoDB Atlas Setup

### Common Error: "user is not allowed to do action [find] on [cluster0.users]"

This error means the database name in your `MONGODB_URI` is wrong **or** the database user lacks read/write privileges.

#### Step 1 — Use the correct database name

In a MongoDB Atlas connection string the segment **after the last `/`** and **before `?`** is the **database name**, not the cluster name.

| | Example |
|---|---|
| ❌ Wrong | `...mongodb.net/cluster0?retryWrites=true` |
| ✅ Correct | `...mongodb.net/esamz?retryWrites=true` |

**How to find your database name:**
1. Open [MongoDB Atlas](https://cloud.mongodb.com) and select your project.
2. Click **Browse Collections** on your cluster.
3. The name displayed in the left panel (e.g. `esamz`) is the database name you should use.

#### Step 2 — Grant the correct privileges to your database user

1. In Atlas go to **Database Access** → click **Edit** next to your user (e.g. `new-man`).
2. Under **Database User Privileges** → **Add Built-in Role**.
3. Select **"Read and write to any database"** (or scope it to `esamz` only).
4. Click **Update User** and wait ~60 seconds for changes to propagate.

#### Step 3 — Whitelist your deployment IP

Serverless platforms (Vercel, Render, etc.) use dynamic IPs. Allow all IPs:
1. Atlas → **Network Access** → **+ Add IP Address**.
2. Click **Allow Access from Anywhere** (`0.0.0.0/0`) → **Confirm**.

#### Correct `MONGODB_URI` format

```
mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/esamz?retryWrites=true&w=majority
```

See `.env.example` for full documentation of all required environment variables.
