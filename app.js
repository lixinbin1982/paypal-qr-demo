const express = require('express');
const path = require('path');
const axios = require('axios');
const QRCode = require('qrcode');
const app = express();
const PORT = process.env.PORT || 3457;

// Live credentials (use env vars in production)
const LIVE_CLIENT_ID = process.env.PAYPAL_LIVE_CLIENT_ID || 'AVHelYkeISS6fnW6Nr305JicpQe1wfszAsHcGh_G-5Wh7qlCSdUZ_MNyvXzvXJPAOnc9rKtFuP7IV0Zi';
const LIVE_CLIENT_SECRET = process.env.PAYPAL_LIVE_CLIENT_SECRET || 'EDufemrQ3Bxuo3St_NhTAQ8HJCx0iRjFnJDGyFkqt06B1hWCDWSI2lhM5u6eSFkZTf_-5ONDFlZ02oy8';
const LIVE_BASE_URL = 'https://api-m.paypal.com';

// Sandbox credentials (use env vars in production)
const SANDBOX_CLIENT_ID = process.env.PAYPAL_SANDBOX_CLIENT_ID || 'AVJ64pXVas3BtB-YrVVMFfCAZx2r2RlEjn0TwRtpGGNxqhhR-DRILDWX8gONSh-jSgunDQucOrVplXtm';
const SANDBOX_CLIENT_SECRET = process.env.PAYPAL_SANDBOX_CLIENT_SECRET || 'EF7BTKS5-hA43DK29EJ9cfAvSWPKkaQ1tAd9wy6BeUhAtoZ55NSG-vddh42_zp1QXrCSa77dTCuJIMzj';
const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

// Credential mode — toggled via API
let credentialMode = 'sandbox'; // 'live' or 'sandbox'

function getCreds() {
  if (credentialMode === 'live') {
    return { CLIENT_ID: LIVE_CLIENT_ID, CLIENT_SECRET: LIVE_CLIENT_SECRET, BASE_URL: LIVE_BASE_URL };
  }
  return { CLIENT_ID: SANDBOX_CLIENT_ID, CLIENT_SECRET: SANDBOX_CLIENT_SECRET, BASE_URL: SANDBOX_BASE_URL };
}

// Helper: get base URL from request (handles ngrok/localhost)
function getBaseUrl(req) {
  const host = req.headers['host'] || 'localhost:3457';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return proto + '://' + host;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----- In-memory stores -----
const bopisOrders = {};

// ----- PayPal Auth -----
let tokenCache = { accessToken: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }
  const { CLIENT_ID, CLIENT_SECRET, BASE_URL } = getCreds();
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(`${BASE_URL}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );
  tokenCache.accessToken = res.data.access_token;
  tokenCache.expiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
  console.log('✅ [' + credentialMode.toUpperCase() + '] Access token obtained, expires in', res.data.expires_in, 's');
  return res.data.access_token;
}

// ==================== Credential Toggle API ====================
app.get('/api/credential', (req, res) => {
  const { CLIENT_ID, BASE_URL } = getCreds();
  res.json({ mode: credentialMode, clientId: CLIENT_ID, baseUrl: BASE_URL });
});

app.post('/api/credential', (req, res) => {
  const { mode } = req.body;
  if (mode !== 'live' && mode !== 'sandbox') {
    return res.status(400).json({ error: 'Invalid mode. Use "live" or "sandbox".' });
  }
  credentialMode = mode;
  // Clear token cache so next call uses new creds
  tokenCache = { accessToken: null, expiresAt: 0 };
  const { CLIENT_ID, BASE_URL } = getCreds();
  console.log('🔀 Switched to', mode.toUpperCase());
  res.json({ mode: credentialMode, clientId: CLIENT_ID, baseUrl: BASE_URL });
});

// ==================== QR CODE (Orders API + self-generated QR) ====================

app.post('/create-qr', async (req, res) => {
  try {
    const { amount, currency } = req.body;
    const value = amount || '1.00';
    const curr = currency || 'USD';
    const { CLIENT_ID, BASE_URL } = getCreds();
    const token = await getAccessToken();

    const orderRes = await axios.post(`${BASE_URL}/v2/checkout/orders`, {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: curr, value: value },
        description: 'QR Demo Payment'
      }],
      payment_source: {
        paypal: {
          experience_context: {
            payment_method_selected: 'PAYPAL_PAY_LATER',
            brand_name: 'QR Demo Merchant',
            locale: 'en-US',
            landing_page: 'LOGIN',
            user_action: 'PAY_NOW',
            return_url: getBaseUrl(req) + '/success',
            cancel_url: getBaseUrl(req) + '/'
          }
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `QR-${Date.now()}`
      }
    });

    const order = orderRes.data;
    console.log('✅ Order created:', order.id, 'status:', order.status);

    const approveLink = order.links.find(l => l.rel === 'payer-action');
    const payLink = approveLink ? approveLink.href : null;

    if (!payLink) {
      return res.render('index', {
        mode: credentialMode, clientId: CLIENT_ID,
        error: 'Order created but no payer-action link found. Status: ' + order.status,
        qrCode: null, orderData: order, orderId: order.id,
        payLink: null, amount: value, currency: curr,
        storeItems
      });
    }

    const qrDataUrl = await QRCode.toDataURL(payLink, {
      width: 400, margin: 2, color: { dark: '#003087', light: '#ffffff' }
    });

    global.__lastRealOrder = { id: order.id, status: order.status, created: Date.now() };

    res.render('index', {
      mode: credentialMode, clientId: CLIENT_ID,
      error: null, qrCode: qrDataUrl, orderData: order, orderId: order.id,
      payLink: payLink, amount: value, currency: curr,
      storeItems
    });

  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
    const { CLIENT_ID } = getCreds();
    res.render('index', {
      mode: credentialMode, clientId: CLIENT_ID,
      error: JSON.stringify(err.response?.data || err.message, null, 2),
      qrCode: null, orderData: null, orderId: null,
      payLink: null, amount: req.body?.amount || '1.00', currency: req.body?.currency || 'USD',
      storeItems
    });
  }
});

app.post('/check-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    const { BASE_URL } = getCreds();
    const token = await getAccessToken();
    const checkRes = await axios.get(`${BASE_URL}/v2/checkout/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const order = checkRes.data;

    if (order.status === 'APPROVED') {
      console.log('🔵 Order APPROVED, capturing...', orderId);
      try {
        const captureRes = await axios.post(`${BASE_URL}/v2/checkout/orders/${orderId}/capture`, {}, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'PayPal-Request-Id': `CAP-${orderId}-${Date.now()}`
          }
        });
        console.log('✅ Capture success:', captureRes.data.status);
        return res.json(captureRes.data);
      } catch (capErr) {
        console.error('❌ Capture failed:', capErr.response?.data || capErr.message);
        return res.json({ ...order, _capture_error: capErr.response?.data || capErr.message });
      }
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ==================== BOPIS — QR Code Pickup ====================

const storeItems = [
  { id: 'item-001', name: 'iPhone 16 Pro', price: '35.00', image: '📱' },
  { id: 'item-002', name: 'Sony WH-1000XM5', price: '35.00', image: '🎧' },
  { id: 'item-003', name: 'Apple Watch Ultra 2', price: '35.00', image: '⌚' },
  { id: 'item-004', name: 'iPad Mini 7', price: '35.00', image: '📟' },
  { id: 'item-005', name: 'AirPods Max', price: '35.00', image: '🎤' },
  { id: 'item-000', name: 'Quick Test • $0.10', price: '0.10', image: '🧪' },
];

// BOPIS — create order with QR + payment link (frontend calls this)
app.post('/bopis/create', async (req, res) => {
  try {
    const { items, currency } = req.body;
    const curr = currency || 'USD';
    const { BASE_URL } = getCreds();

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items selected' });
    }

    const total = items.reduce((sum, sku) => {
      const item = storeItems.find(i => i.id === sku);
      return sum + (item ? parseFloat(item.price) : 0);
    }, 0);

    const pickupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const token = await getAccessToken();

    const orderRes = await axios.post(`${BASE_URL}/v2/checkout/orders`, {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: curr,
          value: total.toFixed(2),
          breakdown: {
            item_total: {
              currency_code: curr,
              value: total.toFixed(2)
            }
          }
        },
        items: items.map(sku => {
          const item = storeItems.find(i => i.id === sku);
          return {
            name: item.name,
            quantity: '1',
            unit_amount: { currency_code: curr, value: item.price },
            category: 'PHYSICAL_GOODS'
          };
        }),
        description: 'BOPIS — Store Pickup (Code: ' + pickupCode + ')',
        shipping: {
          options: [
            {
              id: 'store_pickup',
              label: 'Store Pickup — Downtown San Jose',
              type: 'PICKUP',
              selected: true,
              amount: { currency_code: 'USD', value: '0.00' }
            },
            {
              id: 'us_standard',
              label: 'US Standard Delivery',
              type: 'SHIPPING',
              selected: false,
              amount: { currency_code: 'USD', value: '10.00' }
            },
            {
              id: 'us_express',
              label: 'US Express Delivery',
              type: 'SHIPPING',
              selected: false,
              amount: { currency_code: 'USD', value: '18.00' }
            },
            {
              id: 'intl_standard',
              label: 'International Delivery',
              type: 'SHIPPING',
              selected: false,
              amount: { currency_code: 'USD', value: '14.99' }
            }
          ]
        }
      }],
      payment_source: {
        paypal: {
          experience_context: {
            payment_method_selected: 'PAYPAL_PAY_LATER',
            brand_name: 'BOPIS Store',
            locale: 'en-US',
            landing_page: 'LOGIN',
            user_action: 'PAY_NOW',
            shipping_preference: 'GET_FROM_FILE',
            return_url: getBaseUrl(req) + '/bopis/success?code=' + pickupCode,
            cancel_url: getBaseUrl(req) + '/'
          }
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `BOPIS-${Date.now()}`
      }
    });

    const order = orderRes.data;

    bopisOrders[pickupCode] = {
      paypalOrderId: order.id,
      status: 'PAYMENT_PENDING',
      pickupCode,
      items: items.map(sku => storeItems.find(i => i.id === sku)),
      total: total.toFixed(2),
      currency: curr,
      createdAt: new Date().toISOString(),
      pickedUpAt: null
    };

    const approveLink = order.links.find(l => l.rel === 'payer-action');
    const payLink = approveLink ? approveLink.href : null;

    if (!payLink) {
      return res.status(500).json({ error: 'No payer-action link' });
    }

    const qrDataUrl = await QRCode.toDataURL(payLink, {
      width: 400, margin: 2, color: { dark: '#003087', light: '#ffffff' }
    });

    res.json({
      order,
      pickupCode,
      payLink,
      qrCode: qrDataUrl,
      bopis: bopisOrders[pickupCode]
    });

  } catch (err) {
    console.error('❌ BOPIS create error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// BOPIS — mark pickup
app.post('/bopis/pickup', (req, res) => {
  const { pickupCode } = req.body;
  const bopis = bopisOrders[pickupCode];
  if (!bopis) return res.status(404).json({ error: 'Pickup code not found' });
  if (bopis.status !== 'READY_FOR_PICKUP') {
    return res.status(400).json({ error: 'Order not ready for pickup', status: bopis.status });
  }
  bopis.status = 'PICKED_UP';
  bopis.pickedUpAt = new Date().toISOString();
  console.log('✅ BOPIS picked up:', pickupCode);
  res.json({ bopis });
});

// BOPIS — lookup (merchant admin)
app.get('/bopis/orders', (req, res) => {
  res.json({
    orders: Object.entries(bopisOrders).map(([code, order]) => ({
      pickupCode: code, ...order
    })).reverse()
  });
});

// ================================================

app.get('/success', (req, res) => {
  res.render('success');
});

// BOPIS — success page after PayPal redirect
app.get('/bopis/success', (req, res) => {
  const { code, token } = req.query;
  const pickupCode = code || req.query.code;
  const paypalOrderId = token || null;

  const bopis = bopisOrders[pickupCode];

  if (!bopis && !paypalOrderId) {
    return res.render('bopis-success', {
      error: 'No order data found. Use the home page to look up your order.',
      order: null
    });
  }

  // If we have a local bopis record, use it
  if (bopis) {
    // Update status to READY_FOR_PICKUP (payment completed)
    if (bopis.status === 'PAYMENT_PENDING') {
      bopis.status = 'READY_FOR_PICKUP';
    }
    return res.render('bopis-success', {
      error: null,
      order: bopis
    });
  }

  // If we only have PayPal order ID, show basic success
  res.render('bopis-success', {
    error: null,
    order: {
      pickupCode: pickupCode || '—',
      paypalOrderId: paypalOrderId,
      status: 'PAYMENT_PENDING',
      items: [],
      total: '—',
      currency: 'USD',
      createdAt: new Date().toISOString(),
      pickedUpAt: null
    }
  });
});

app.get('/', (req, res) => {
  const { CLIENT_ID } = getCreds();
  res.render('index', {
    mode: credentialMode,
    clientId: CLIENT_ID,
    error: null, qrCode: null, orderData: null, orderId: null,
    payLink: null, amount: null, currency: null,
    storeItems,
    defaultTab: 'bopis'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  const { BASE_URL } = getCreds();
  console.log(`🚀 PayPal QR Demo running at http://localhost:${PORT}`);
  console.log(`🔀 Credential: LIVE (sandbox available via toggle)`);
  console.log(`📦 BOPIS with shipping options ready`);
});
