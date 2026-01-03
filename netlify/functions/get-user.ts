
import { getStore } from "@netlify/blobs";

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response("Method not allowed", { status: 405 });

  try {
    const { email, uid } = await req.json();
    if (!email || !uid) return new Response("Missing details", { status: 400 });

    const store = getStore({ name: "user-profiles", consistency: "strong" });
    let profile = await store.get(uid, { type: "json" });

    if (!profile) {
      profile = {
        uid,
        email,
        isPro: false,
        secondsUsed: 0,
        lastReset: new Date().toISOString()
      };
      await store.setJSON(uid, profile);
    }

    // Monthly usage reset logic
    const lastReset = new Date(profile.lastReset);
    const now = new Date();
    if (now.getMonth() !== lastReset.getMonth() || now.getFullYear() !== lastReset.getFullYear()) {
      profile.secondsUsed = 0;
      profile.lastReset = now.toISOString();
      await store.setJSON(uid, profile);
    }

    return new Response(JSON.stringify(profile), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
