
import { getStore } from "@netlify/blobs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return new Response("Method Not Allowed", { status: 405 });

  try {
    const { action, code, uid } = await req.json();
    const clientId = process.env.VITE_GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
      return new Response(JSON.stringify({ error: "Google credentials not configured" }), { status: 500, headers: corsHeaders });
    }

    const userStore = getStore({ name: "user-profiles", consistency: "strong" });

    // ACTION: EXCHANGE CODE FOR TOKENS
    if (action === 'exchange_code') {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: req.headers.get('origin') || '',
          grant_type: 'authorization_code',
        }),
      });

      const data = await response.json();
      if (data.refresh_token) {
        // Save refresh token to user profile
        const profile = await userStore.get(uid, { type: "json" }) as any;
        if (profile) {
          profile.driveRefreshToken = data.refresh_token;
          await userStore.setJSON(uid, profile);
        }
      }

      return new Response(JSON.stringify({ access_token: data.access_token }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ACTION: GET FRESH ACCESS TOKEN
    if (action === 'get_token') {
      const profile = await userStore.get(uid, { type: "json" }) as any;
      if (!profile || !profile.driveRefreshToken) {
        return new Response(JSON.stringify({ error: "No refresh token found" }), { status: 404, headers: corsHeaders });
      }

      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: profile.driveRefreshToken,
          grant_type: 'refresh_token',
        }),
      });

      const data = await response.json();
      return new Response(JSON.stringify({ access_token: data.access_token }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ACTION: DISCONNECT
    if (action === 'disconnect') {
      const profile = await userStore.get(uid, { type: "json" }) as any;
      if (profile) {
        delete profile.driveRefreshToken;
        await userStore.setJSON(uid, profile);
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    return new Response("Invalid Action", { status: 400, headers: corsHeaders });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};
