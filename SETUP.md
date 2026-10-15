# WhatsApp Business Coexistence Setup Guide

This guide walks you through connecting your existing **WhatsApp Business App** mobile number (iOS or Android) to **wacrm** using Meta's official **Coexistence** mode.

---

## What is Coexistence Mode?

Coexistence allows the **WhatsApp Business App on your physical phone** and the **Meta WhatsApp Cloud API (wacrm)** to share the same phone number at the same time:

- **WhatsApp Business App on phone**: Continues working normally. All chat history, existing conversations, calls, and mobile features remain active.
- **wacrm Web App**: Receives all incoming customer messages, syncs customer contacts, imports recent chat history, and receives echoes of outgoing messages sent from the mobile app (badged as `from Business App`).
- **No Migration / No Takeover**: The phone is **never logged out**, and the number is **never deregistered** from the mobile app.

---

## Critical Safety Rule: No `/register` or PIN for Coexistence

> **IMPORTANT**: Under NO circumstances should you register or set a Two-Step PIN for a Coexistence number.
>
> In standard Cloud API onboarding, calling `POST /{phone_number_id}/register` with a 6-digit PIN **deregisters** the phone number from the physical device and takes it over exclusively for Cloud API.
>
> Coexistence numbers are **already registered** via the physical phone using SMS/voice OTP. Embedded Signup authorizes wacrm without taking over the number.
>
> **wacrm includes server-side safety guards (`assertNotCoexistence`)** that block any `/register`, `/deregister`, or PIN modification requests if a number is in coexistence mode.

---

## Supported Regions

Meta officially supports WhatsApp Business App Coexistence in countries worldwide where Cloud API and WhatsApp Business App operate, including:
- **India (+91)**
- **United Arab Emirates (+971)**
- **United States & Canada (+1)**
- **United Kingdom (+44)**
- **European Union (+33, +49, +34, etc.)**
- **Brazil (+55)**
- **Indonesia (+62)**
- And all other standard Meta WhatsApp supported regions.

---

## Known Limitations of Coexistence

Keep these Meta architectural constraints in mind:

1. **Mobile App Inactivity Disconnection (~14 Days)**:
   Meta requires that the physical WhatsApp Business App on the phone be opened at least once every **10–14 days**. If the phone is powered off, uninstalled, or completely inactive for more than 14 days, Meta automatically disconnects the Cloud API integration and unlinks the number.
2. **Mobile App Only Features**:
   - **Broadcast Lists** created on the mobile app are not sent through the Cloud API.
   - **View-Once Media** and **Disappearing Messages** are not synced across the Cloud API.
   - **Voice/Video Calls** handled on the phone do not emit call logs to the Cloud API.
   - **Quick Replies & Catalogs** configured inside the mobile app do not automatically sync to Cloud API templates.
3. **Outgoing Message Source**:
   - Messages sent from **wacrm** appear on the customer's phone and inside wacrm.
   - Messages sent by staff directly from the **WhatsApp Business phone app** appear in wacrm as message echoes with a `"from Business App"` badge.

---

## Prerequisites

Before starting, ensure you have:
1. A **Meta Developer Account** ([developers.facebook.com](https://developers.facebook.com/)).
2. A **Meta Business Portfolio (Business Manager)** verified or capable of creating apps.
3. A physical smartphone with the **WhatsApp Business App** active with your number.
4. Your self-hosted `wacrm` instance running (locally or on your server) with HTTPS (or `localhost` for development).

---

## Step 1: Set Up Your Meta Developer App (Tech Provider Setup)

1. Log into [Meta for Developers](https://developers.facebook.com/).
2. Click **My Apps** → **Create App**.
3. Select **Other** as the use case, then choose **Business** as the app type.
4. Enter an App Name (e.g., `My CRM WhatsApp Gateway`).
5. Select your **Meta Business Portfolio**.
6. Once created, in the left navigation sidebar under **Add products to your app**, locate **WhatsApp** and click **Set up**.

---

## Step 2: Configure Embedded Signup & Login Configuration ID

Coexistence requires Meta Embedded Signup with the `whatsapp_business_app_onboarding` feature enabled:

1. In your Meta Developer App, go to **WhatsApp** → **Quickstart** or **Configuration**.
2. Scroll to **Embedded Signup** and click **Set Up** (or go to **Facebook Login for Business** → **Configurations**).
3. Create a new **Login Configuration**:
   - **Configuration Name**: `wacrm_coexistence_signup`
   - **Permissions Requested**:
     - `whatsapp_business_management`
     - `whatsapp_business_messaging`
   - **Features**: Ensure **WhatsApp Business App Onboarding (Coexistence)** is checked / enabled (`featureType: 'whatsapp_business_app_onboarding'`).
4. Note the generated **Login Configuration ID** (a numeric string, e.g., `123456789012345`).

---

## Step 3: Crucial Troubleshooting: "This Meta Business Account owns the app"

### Why This Error Happens
If you attempt to onboard your number using the **same** Meta Business Portfolio that owns the Meta Developer App, Meta's Embedded Signup will fail with:
> *"This Meta Business Account owns the app. You cannot onboard an account owned by the app owner through Embedded Signup."*

Meta designed Embedded Signup for Tech Providers / Solution Providers where:
- **Portfolio A (Developer Portfolio)**: Owns the Meta Developer App.
- **Portfolio B (Client Portfolio)**: Owns the WhatsApp Business Account and phone number.

### How to Resolve This:
- **Option 1 (Recommended for testing & production)**:
  Use a separate Meta Business Portfolio (or personal account / different business profile) to hold the WhatsApp Business number during Embedded Signup.
- **Option 2 (Add test users)**:
  Under **App Roles** → **Roles**, invite a separate Facebook user as a Tester/Developer under the app, and log into Embedded Signup with that user.
- **Option 3 (For standalone numbers without mobile coexistence)**:
  If you do not need the mobile app on the phone and only need Cloud API, use the **Advanced: manual Cloud API credentials** accordion in wacrm Settings.

---

## Step 4: Configure Webhooks in Meta App Dashboard

1. In the Meta Developer App, navigate to **WhatsApp** → **Configuration**.
2. Under **Webhook**, click **Edit**:
   - **Callback URL**: `https://your-domain.com/api/whatsapp/webhook` (or your ngrok URL for local dev).
   - **Verify Token**: A secure random string you choose (e.g. generated via `openssl rand -hex 16`).
3. Click **Verify and Save**.
4. In **Webhook fields**, click **Manage** and subscribe to:
   - `messages` (customer messages, status updates)
   - `smb_message_echoes` (echoes of messages sent from mobile phone)
   - `smb_app_state_sync` (contact synchronization from mobile phone)
   - `history` (chat history import chunks)
   - `account_update` (disconnection / offboarding notifications)

---

## Step 5: Configure wacrm Environment Variables

Update your `.env.local` (or server environment variables) with:

```bash
# Meta App credentials (from App Settings → Basic)
META_APP_ID=your_meta_app_id
NEXT_PUBLIC_META_APP_ID=your_meta_app_id
META_APP_SECRET=your_meta_app_secret

# Login Configuration ID for Embedded Signup (Step 2)
META_CONFIG_ID=your_meta_login_config_id
NEXT_PUBLIC_META_CONFIG_ID=your_meta_login_config_id

# Meta Graph API version
GRAPH_API_VERSION=v22.0

# 64-hex char encryption key for token storage
ENCRYPTION_KEY=your_64_char_hex_encryption_key

# Supabase configuration
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

Restart your wacrm development or production server:
```bash
npm run dev
# or in production:
# npm run build && npm run start
```

---

## Step 6: Onboard via Settings in wacrm

1. In wacrm, navigate to **Settings** → **WhatsApp** (`/settings/whatsapp`).
2. You will see the **WhatsApp Business App Coexistence** panel at the top.
3. Click:
   ```
   [ Connect existing WhatsApp Business App number (Coexistence) ]
   ```
4. The Meta Embedded Signup modal will open:
   - Log into Facebook.
   - Select or confirm your Business Portfolio.
   - Choose your existing **WhatsApp Business App** phone number.
   - When prompted:
     - Allow wacrm to access your WhatsApp Business Account.
     - Allow contact sync and chat history sync.
5. Upon completion, the popup closes automatically and wacrm:
   - Exchanges the authorization code for a system user access token.
   - Verifies the phone number state with Meta Graph API.
   - Subscribes the WABA to your app's webhooks.
   - Requests contact sync and chat history sync via `smb_app_data`.
   - Stores the encrypted token with `connection_mode = 'coexistence'`.

---

## Step 7: Verifying Successful Connection

Once connected, your Settings page will display:
- **Coexistence Mode Badge**: Green badge confirming active coexistence.
- **Phone Details**: Display number, verified name, and quality rating.
- **Contacts Sync**: Shows synced count / status.
- **Chat History Sync**: Shows progress (Phase 0: 24h, Phase 1: 90d, Phase 2: 180d).
- **Inactivity Warning**: Reminds staff to keep the physical WhatsApp Business App active every 10–14 days.

### Checking Inbox Echoes
1. Open the physical WhatsApp Business App on your phone.
2. Send a message to any customer.
3. Open wacrm **Inbox** (`/inbox`).
4. Notice the message appears in the conversation with a **`from Business App`** badge and smartphone icon.

---

## Disconnecting Safely

To disconnect:
1. In wacrm **Settings** → **WhatsApp**, click **Disconnect Coexistence**.
2. Confirm the prompt.
3. wacrm will unsubscribe the WABA from the app and clear stored credentials **without deregistering or affecting the WhatsApp Business App on the physical phone**.
