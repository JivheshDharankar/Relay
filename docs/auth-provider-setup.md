# Relay Authentication Provider Setup & Integration Guide

This guide documents the configuration requirements, credentials, redirect URIs, scopes, and setup steps for Relay's real authentication providers:
1. Google OAuth 2.0 / OpenID Connect
2. Email OTP (Resend REST API)
3. Phone OTP (Twilio REST API)

All secrets must reside exclusively in server-side environment variables (`backend/.env`). **Never expose client secrets, access tokens, or private keys to the frontend browser application.**

---

## 1. Google OAuth 2.0 / OpenID Connect

### A. Provider Console
- **Console**: [Google Cloud Console](https://console.cloud.google.com/)
- **Section**: **APIs & Services** $\to$ **Credentials** $\to$ **Create Credentials** $\to$ **OAuth client ID**
- **Application Type**: **Web application**

### B. Configuration Parameters
| Parameter | Local Development | Production |
| :--- | :--- | :--- |
| **Name** | `Relay Local Dev` | `Relay Production` |
| **Authorized JavaScript Origins** | `http://localhost:3000`, `http://localhost:4000` | `https://relaycommunity.com` |
| **Authorized Redirect URIs** | `http://localhost:4000/api/auth/google/callback` | `https://api.relaycommunity.com/api/auth/google/callback` |
| **Scopes** | `openid`, `email`, `profile` | `openid`, `email`, `profile` |

### C. Environment Variables
Add to `backend/.env`:
```bash
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:4000/api/auth/google/callback
```

### D. Verification & Common Errors
- **Verification**: Navigate to `http://localhost:4000/api/auth/google` in your browser. It should redirect to Google's consent screen showing the requested scopes.
- **Common Error: `redirect_uri_mismatch`**:
  - The URI configured in Google Cloud Console must match `GOOGLE_REDIRECT_URI` character-for-character, including trailing slashes and port numbers.
- **Common Error: `access_denied` / Unverified App**:
  - If the OAuth consent screen is set to **External** and **Testing**, add test user email addresses under **Test users** in Google Cloud Console.

---

## 2. Email OTP Delivery (Resend)

### A. Provider Console
- **Console**: [Resend Console](https://resend.com/overview)
- **Section**: **API Keys** $\to$ **Create API Key** (Permission: Full Access or Sending Access)
- **Domains**: Verify your domain (e.g., `relaycommunity.com`) under **Domains** tab.

### B. Environment Variables
Add to `backend/.env`:
```bash
RESEND_API_KEY=re_your_resend_api_key
RESEND_FROM_EMAIL=Relay Authentication <auth@relaycommunity.com>
```

### C. Development / Test Mode
If `RESEND_API_KEY` is omitted, Relay operates in graceful non-production test mode:
- Generates cryptographically secure 6-digit OTPs.
- Validates expiration (5 minutes) and max attempts (3).
- Records mock email dispatch without leaking the secret code in logs.
- Enables end-to-end testing without external email credits.

---

## 3. Phone OTP Delivery (Twilio SMS)

### A. Provider Console
- **Console**: [Twilio Console](https://console.twilio.com/)
- **Section**: **Account** $\to$ **API keys & tokens** $\to$ Copy **Account SID** and **Auth Token**
- **Phone Numbers**: Purchase or configure a dedicated SMS-enabled phone number under **Phone Numbers** $\to$ **Manage** $\to$ **Active Numbers**.

### B. Environment Variables
Add to `backend/.env`:
```bash
TWILIO_ACCOUNT_SID=ACyour_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=+1234567890
SMS_PROVIDER=twilio
```

### C. Development / Test Mode
If Twilio credentials are not set in the environment:
- `SMS_PROVIDER=mock` activates the in-memory SMS carrier.
- Generates cryptographically secure 6-digit OTPs.
- Validates cooldowns and attempt ceilings.
- Never logs OTP values.

---

## 4. Security & Invariant Checklist

| Security Control | Implementation |
| :--- | :--- |
| **CSRF Defense** | Single-use cryptographically random state parameter (`rly_st_*`) with 10-minute sliding TTL. |
| **Zero Token Leakage** | All tokens, client secrets, and passwords stripped by `IdentityAuditService` before event publishing. |
| **Rate Limiting** | `AUTH_ATTEMPT` (5/min) and `OTP_REQUEST` (3/2min) protect login and OTP endpoints. |
| **Brute Force Protection** | OTP invalidated immediately upon 3 consecutive failed verification attempts. |
| **Replay Defense** | OTP deleted immediately upon successful authentication. |
| **IDOR Protection** | 1:1 server-side mapping between `UserIdentity` and `residentId`. AI cannot impersonate identities. |

