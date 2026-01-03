
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

export default async (req: Request) => {
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    console.error("Missing signature or webhook secret");
    return new Response("Webhook Secret not configured or missing signature", { status: 400 });
  }

  const payload = await req.text();

  // Verify Stripe Signature manually (since we don't use the heavy Stripe SDK here)
  try {
    const parts = signature.split(",");
    const timestamp = parts.find(p => p.startsWith("t="))?.split("=")[1];
    const sigV1 = parts.find(p => p.startsWith("v1="))?.split("=")[1];

    if (!timestamp || !sigV1) throw new Error("Invalid signature format");

    // Check if the signature is too old (more than 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 300) throw new Error("Signature timestamp expired");

    // Construct the signed payload
    const signedPayload = `${timestamp}.${payload}`;
    const expectedSig = createHmac("sha256", webhookSecret)
      .update(signedPayload)
      .digest("hex");

    // Secure comparison
    if (!timingSafeEqual(Buffer.from(sigV1, "hex"), Buffer.from(expectedSig, "hex"))) {
      throw new Error("Signature mismatch");
    }
  } catch (err: any) {
    console.error("Signature verification failed:", err.message);
    return new Response("Invalid Signature", { status: 401 });
  }

  // If we reach here, the request is definitely from Stripe
  const event = JSON.parse(payload);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const uid = session.client_reference_id;

    if (uid) {
      const store = getStore({ name: "user-profiles", consistency: "strong" });
      const profile = await store.get(uid, { type: "json" }) as any;
      if (profile) {
        profile.isPro = true;
        profile.stripeCustomerId = session.customer;
        await store.setJSON(uid, profile);
        console.log(`[Stripe] Successfully upgraded User ${uid} (${profile.email}) to PRO.`);
      } else {
        console.warn(`[Stripe] Session completed but user profile for UID ${uid} not found.`);
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" }
  });
};
