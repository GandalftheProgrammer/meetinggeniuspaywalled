
import { getStore } from "@netlify/blobs";

export default async (req: Request) => {
  const payload = await req.text();
  const event = JSON.parse(payload);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const uid = session.client_reference_id;

    if (uid) {
      const store = getStore({ name: "user-profiles", consistency: "strong" });
      const profile = await store.get(uid, { type: "json" });
      if (profile) {
        profile.isPro = true;
        profile.stripeCustomerId = session.customer;
        await store.setJSON(uid, profile);
        console.log(`User ${uid} upgraded to PRO.`);
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" }
  });
};
