
// NOTE: You need a STRIPE_SECRET_KEY in your Netlify environment variables
// This uses a placeholder Price ID 'price_123456' - replace with your actual Stripe Price ID

export default async (req: Request) => {
  const { email, uid } = await req.json();
  
  // Real world: Use the Stripe SDK. For simplicity here, we use the Stripe REST API directly.
  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const PRICE_ID = process.env.STRIPE_PRICE_ID || "price_123456"; // REPLACE THIS

  const body = new URLSearchParams({
    'success_url': `${req.headers.get('origin')}/?session_id={CHECKOUT_SESSION_ID}`,
    'cancel_url': `${req.headers.get('origin')}/`,
    'mode': 'subscription',
    'customer_email': email,
    'client_reference_id': uid,
    'line_items[0][price]': PRICE_ID,
    'line_items[0][quantity]': '1'
  });

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const session = await res.json();
  return new Response(JSON.stringify({ url: session.url }), {
    headers: { "Content-Type": "application/json" }
  });
};
