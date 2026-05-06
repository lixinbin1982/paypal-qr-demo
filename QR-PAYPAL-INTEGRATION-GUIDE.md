# PayPal QR Code 付款 & BOPIS QR Pickup — 整合步骤

> 呢份文件系俾 merchant 睇嘅，用中文解释点样整合 PayPal QR Code 付款同 BOPIS（Buy Online, Pick Up In Store）功能。

---

## 一、整合流程总览

```
1. 攞 PayPal Access Token（OAuth 2.0）
   ↓
2. 用 Orders API 建立 Order（POST /v2/checkout/orders）
   ↓
3. 从 response 攞「payer-action link」（即付款链接）
   ↓
4. 将付款链接生成 QR Code（俾客人扫）或做 Payment Link（俾人㩒）
   ↓
5. 客人扫描 QR → 打开 PayPal 付款页面 → 完成付款
   ↓
6. 用 check-order API 侦测 Order 状态（APPROVED → 自动 Capture）
   ↓
7. 扣款完成（COMPLETED）
```

---

## 二、前置准备

### 2.1 申请 PayPal API Credentials

| 环境 | 用途 | 获取位置 |
|------|------|----------|
| **Sandbox（沙箱）** | 测试用，用假钱 | https://developer.paypal.com/dashboard/applications → **Sandbox accounts → N/A account → API credentials** |
| **Live（正式）** | 上线用，真钱 | https://developer.paypal.com/dashboard/applications → **REST API apps → Create App** |

你需要攞到：
- **Client ID**
- **Client Secret**

### 2.2 API Endpoint 地址

| 环境 | Base URL |
|------|----------|
| Sandbox | `https://api-m.sandbox.paypal.com` |
| Live | `https://api-m.paypal.com` |

---

## 三、Step-by-Step 整合

### Step 1：攞 Access Token（OAuth 2.0）

每次调用 PayPal API 之前，先用 Client ID + Client Secret 攞一个临时 token。

**Request**

```
POST {BASE_URL}/v1/oauth2/token
Authorization: Basic base64(Client_ID:Client_Secret)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

**Node.js 代码示例**

```javascript
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

const accessToken = res.data.access_token;  // 🔑 呢个就系你要嘅 token
const expiresIn = res.data.expires_in;       // 有效期（秒），约 9 小时
```

> ⚠️ Token 有效期约 **32400 秒（9 小时）**，建议 cache 住唔好每次都攞新。

---

### Step 2：建立 Order（QR Code 付款）

用 Orders API 建立一个未付款嘅 Order，PayPal 会俾返一条付款链接。

**Request**

```
POST {BASE_URL}/v2/checkout/orders
Authorization: Bearer {access_token}
Content-Type: application/json
PayPal-Request-Id: QR-1715000000000  ← 幂等 ID，防重复下单

{
  "intent": "CAPTURE",
  "purchase_units": [{
    "amount": {
      "currency_code": "USD",
      "value": "35.00"
    },
    "description": "QR Demo Payment"
  }],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "payment_method_selected": "PAYPAL_PAY_LATER",
        "brand_name": "你的商店名",
        "locale": "en-US",
        "landing_page": "LOGIN",
        "user_action": "PAY_NOW",
        "return_url": "https://你的网站.com/success",
        "cancel_url": "https://你的网站.com/"
      }
    }
  }
}
```

**Response**

```json
{
  "id": "6JY51547J1478104X",
  "status": "CREATED",
  "links": [
    { "rel": "self", "href": "..." },
    { "rel": "payer-action", "href": "https://www.paypal.com/checkoutnow?token=6JY51547J1478104X" }
    //             👆 呢条就系付款链接
  ]
}
```

---

### Step 3：生成 QR Code / Payment Link

从 response 攞 `rel: "payer-action"` 嗰条 link：

```javascript
const approveLink = order.links.find(l => l.rel === 'payer-action');
const payLink = approveLink.href;
```

然后用 qrcode library 生成 QR Code：

```javascript
const QRCode = require('qrcode');

const qrDataUrl = await QRCode.toDataURL(payLink, {
  width: 400,
  margin: 2,
  color: { dark: '#003087', light: '#ffffff' }
});
```

或者直接显示条付款链接俾人㩒都得。

---

### Step 4：监控付款状态 + Auto-Capture

当客人扫 QR → 完成付款后，Order 状态会由 `CREATED` → `APPROVED`。侦测到 `APPROVED` 后要执行 **Capture** 先真正扣钱。

**Check Order Status**

```
GET {BASE_URL}/v2/checkout/orders/{order_id}
Authorization: Bearer {access_token}
```

**如果 status = APPROVED → 执行 Capture**

```
POST {BASE_URL}/v2/checkout/orders/{order_id}/capture
Authorization: Bearer {access_token}
Content-Type: application/json
PayPal-Request-Id: CAP-{order_id}-{timestamp}

（Body 留空）
```

Capture 成功后 `status` 会变成 `COMPLETED`。

---

### Step 5：BOPIS QR Pickup（进阶功能）

BOPIS = 线上买单，线下取货。流程同普通 QR 付款一样，但有几点唔同：

#### 5.1 purchase_units 要加入商品明细 + shipping options

```json
{
  "intent": "CAPTURE",
  "purchase_units": [{
    "amount": {
      "currency_code": "USD",
      "value": "70.00",
      "breakdown": {
        "item_total": {
          "currency_code": "USD",
          "value": "70.00"
        }
      }
    },
    "items": [
      {
        "name": "iPhone 16 Pro",
        "quantity": "1",
        "unit_amount": { "currency_code": "USD", "value": "35.00" },
        "category": "PHYSICAL_GOODS"
      },
      {
        "name": "AirPods Max",
        "quantity": "1",
        "unit_amount": { "currency_code": "USD", "value": "35.00" },
        "category": "PHYSICAL_GOODS"
      }
    ],
    "description": "BOPIS — Store Pickup (Code: AB3X9K)",
    "shipping": {
      "options": [
        {
          "id": "store_pickup",
          "label": "Store Pickup — Downtown San Jose",
          "type": "PICKUP",
          "selected": true,
          "amount": { "currency_code": "USD", "value": "0.00" }
        },
        {
          "id": "us_standard",
          "label": "US Standard Delivery",
          "type": "SHIPPING",
          "selected": false,
          "amount": { "currency_code": "USD", "value": "10.00" }
        }
      ]
    }
  }],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "shipping_preference": "GET_FROM_FILE"
        // 其他字段同 Step 2
      }
    }
  }
}
```

#### 5.2 Merchant 层面的 Pickup Code 管理

你嘅 server 需要自己生成 pickup code，记录对应嘅 order，并提供取货确认功能：

```javascript
// 生成随机 Pickup Code
const pickupCode = Math.random().toString(36).substring(2, 8).toUpperCase();

// 存入数据库
bopisOrders[pickupCode] = {
  paypalOrderId: order.id,
  status: 'PAYMENT_PENDING',  // → READY_FOR_PICKUP → PICKED_UP
  items: [...],
  total: '70.00',
  currency: 'USD',
  createdAt: new Date().toISOString()
};

// 取货确认
function confirmPickup(pickupCode) {
  // 验证 pickup code
  // 更新状态为 PICKED_UP
}
```

#### 5.3 BOPIS 状态流转

```
拣货 → Generate QR → Pay（PayPal）→ 付款完成 → 
  Ready for Pickup → 到店出示 pickup code → 
  店员确认 → Picked Up
```

| 状态 | 含义 |
|------|------|
| `PAYMENT_PENDING` | 已建立 Order，未付款 |
| `READY_FOR_PICKUP` | 已付款，可以取货 |
| `PICKED_UP` | 已取货完成 |

---

## 四、整合要点总结

### 4.1 必须做嘅事 ✅

| 事项 | 说明 |
|------|------|
| **Cache Access Token** | Token 有效期 9 小时，唔好次次重新攞 |
| **幂等 ID（PayPal-Request-Id）** | 每条 request 用唯一 ID，防止重复扣款 |
| **检查 payer-action link** | Order 建立后一定要攞到 `rel: "payer-action"` 呢条 link |
| **Auto-Capture** | 侦测到 APPROVED 后即时 Capture，唔好等 |
| **return_url / cancel_url** | 要用动态 base URL（处理 ngrok / domain 切换） |

### 4.2 常见错误 ❌

| 错误 | 原因 | 解决方法 |
|------|------|----------|
| `UNPROCESSABLE_ENTITY` | Body 格式错 | 检查 JSON 字段名同类型 |
| `UNSUPPORTED_SHIPPING_TYPE` | 直接传 `shipping.type: "PICKUP"` | 唔好直接传 type，用 `shipping.options` 数组代替 |
| `INVALID_ACCOUNT` | Client ID 同 Secret 唔匹配 | 检查 sandbox/live 是否混用 |
| `ORDER_ALREADY_CAPTURED` | 重复 capture | 检查幂等 ID 或用 `GET` 先 check status |
| Token 过期 | 超过 9 小时 | 检查 `expires_in`，提前 refresh |

### 4.3 测试建议 🧪

1. **先用 Sandbox 测试** — 用沙箱 credential，假钱随便试
2. **测试 QR 扫完后再付款** — 用手机扫 QR 或用电脑开 payment link
3. **测试 BOPIS 完整流程** — 拣货 → QR → Pay → 显示 pickup code → Confirm Pickup
4. **测试 cancel 场景** — 取消付款后返 cancel_url 是否正确
5. **测试 ngrok / 生产环境** — 确保 return_url 正确指向外网地址

---

## 五、Demo 网站参考

我哋的 demo 网站（sandbox 环境）：

🌐 **https://foam-riding-component.ngrok-free.dev**

- 🔲 **QR Code Tab** — 输入金额 → Generate QR → 扫 QR 付款
- 🏪 **QR Pickup Tab** — 拣货 → Generate QR → 扫 QR 付款 → 显示 Pickup Code → 后台确认取货

完整 Node.js source code 可以向你索取，或者上 https://clawhub.ai 搵 PayPal demo template。
