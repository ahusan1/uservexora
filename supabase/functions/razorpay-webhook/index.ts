/// <reference path="./globals.d.ts" />
// supabase/functions/razorpay-webhook/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

async function getHmacSha256Hex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const value = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(value)) return null;
    out[i / 2] = value;
  }
  return out;
}

function timingSafeHexEqual(aHex: string, bHex: string): boolean {
  const a = hexToBytes(aHex);
  const b = hexToBytes(bHex);
  if (!a || !b || a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getFirebaseAccessToken(): Promise<{ accessToken: string; projectId: string } | null> {
  const projectId = Deno.env.get("FIREBASE_PROJECT_ID") ?? "";
  const clientEmail = Deno.env.get("FIREBASE_CLIENT_EMAIL") ?? "";
  const privateKeyRaw = Deno.env.get("FIREBASE_PRIVATE_KEY") ?? "";
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );

  const jwt = `${unsignedToken}.${toBase64Url(new Uint8Array(signature))}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    console.error("Failed to fetch Firebase access token", await tokenRes.text());
    return null;
  }

  const tokenJson = await tokenRes.json();
  const accessToken = String(tokenJson?.access_token ?? "");
  if (!accessToken) return null;

  return { accessToken, projectId };
}

async function sendFcmNotificationBatch(
  tokens: string[],
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<void> {
  if (tokens.length === 0) return;

  const auth = await getFirebaseAccessToken();
  if (!auth) {
    console.warn("Skipping FCM send because Firebase credentials are not configured");
    return;
  }

  const endpoint = `https://fcm.googleapis.com/v1/projects/${auth.projectId}/messages:send`;

  await Promise.all(tokens.map(async (token) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data,
            webpush: {
              notification: {
                title,
                body,
                icon: "/icons/icon-192x192.png",
              },
            },
          },
        }),
      });

      if (!response.ok) {
        console.error("FCM send failed", await response.text());
      }
    } catch (error) {
      console.error("FCM send exception", error);
    }
  }));
}

serve(async (req: Request) => {
  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const signature = req.headers.get("x-razorpay-signature");
    const bodyText = await req.text();
    const webhookSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") ?? "";

    // Verify Razorpay Signature securely
    if (!signature || !webhookSecret) {
      return jsonResponse({ error: "Unauthorized: Missing signature or webhook secret" }, 400);
    }

    const expectedSignature = await getHmacSha256Hex(webhookSecret, bodyText);

    if (!timingSafeHexEqual(signature, expectedSignature)) {
      return jsonResponse({ error: "Unauthorized: Invalid signature" }, 400);
    }

    let event: Record<string, any>;
    try {
      event = JSON.parse(bodyText);
    } catch {
      return jsonResponse({ error: "Invalid JSON payload" }, 400);
    }

    if (event.event === "payment.captured") {
      // Initialize Supabase Admin Client to bypass RLS
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      if (!supabaseUrl || !serviceRoleKey) {
        return jsonResponse({ error: "Supabase admin credentials are not configured" }, 500);
      }

      const supabaseAdmin = createClient(
        supabaseUrl,
        serviceRoleKey,
      );

      const paymentEntity = event?.payload?.payment?.entity ?? {};
      const paymentId = paymentEntity?.id;
      // Extract the notes we pass from the frontend
      const notes = paymentEntity?.notes ?? {};
      const user_id = notes.user_id;
      const product_ids = notes.product_ids;
      const coupon_code = String(notes.coupon_code ?? "").trim().toUpperCase();
      const isWalletTopup = String(notes.wallet_topup ?? "") === "true";

      if (!paymentId || !user_id) {
        return jsonResponse({ error: "Missing payment id or user id" }, 400);
      }

      if (isWalletTopup) {
        const amountPaise = Number(paymentEntity?.amount || 0);
        const amount = Math.round(amountPaise) / 100;
        if (!Number.isFinite(amount) || amount <= 0) {
          return jsonResponse({ error: "Invalid top-up amount" }, 400);
        }

        // Try to check for duplicate using new razorpay_payment_id column
        // If column doesn't exist, this will be caught and we'll fall back to reason field
        let existingTopup: any[] = [];
        try {
          const { data } = await supabaseAdmin
            .from("admin_wallet_logs")
            .select("id")
            .eq("seller_id", user_id)
            .eq("razorpay_payment_id", paymentId)
            .limit(1);
          existingTopup = data || [];
        } catch (err) {
          console.log("Column check failed, attempting fallback check with reason field");
          // Fallback: check reason field
          const { data } = await supabaseAdmin
            .from("admin_wallet_logs")
            .select("id")
            .eq("seller_id", user_id)
            .ilike("reason", `%${paymentId}%`)
            .limit(1);
          existingTopup = data || [];
        }

        if (existingTopup && existingTopup.length > 0) {
          return jsonResponse({ success: true, message: "Top-up already processed" }, 200);
        }

        const { data: walletRow, error: walletFetchErr } = await supabaseAdmin
          .from("users")
          .select("wallet_balance")
          .eq("id", user_id)
          .single();

        if (walletFetchErr) {
          return jsonResponse({ error: "Failed to fetch wallet" }, 500);
        }

        const currentBal = Number(walletRow?.wallet_balance || 0);
        const newBal = currentBal + amount;

        const { error: walletErr } = await supabaseAdmin
          .from("users")
          .update({ wallet_balance: newBal })
          .eq("id", user_id);

        if (walletErr) {
          return jsonResponse({ error: "Failed to update wallet" }, 500);
        }

        const { error: logErr } = await supabaseAdmin.from("admin_wallet_logs").insert({
          seller_id: user_id,
          type: "credit",
          amount: amount,
          reason: `Wallet top-up via Razorpay (ID: ${paymentId})`,
          razorpay_payment_id: paymentId,
          admin_id: null
        });

        if (logErr) {
          console.error("Failed to create wallet log with razorpay_payment_id:", logErr);
          
          // Fallback: Try inserting without razorpay_payment_id if column doesn't exist
          if (logErr.message?.includes("razorpay_payment_id")) {
            console.log("Falling back to insert without razorpay_payment_id column");
            const { error: fallbackErr } = await supabaseAdmin.from("admin_wallet_logs").insert({
              seller_id: user_id,
              type: "credit",
              amount: amount,
              reason: `Wallet top-up via Razorpay (ID: ${paymentId})`,
              admin_id: null
            });
            
            if (fallbackErr) {
              console.error("Fallback insert also failed:", fallbackErr);
              return jsonResponse({ error: "Failed to create transaction log" }, 500);
            }
          } else {
            return jsonResponse({ error: "Failed to create transaction log" }, 500);
          }
        }

        return jsonResponse({ success: true, wallet_balance: newBal }, 200);
      }

      if (!product_ids) {
        return jsonResponse({ error: "Missing product ids for order processing" }, 400);
      }

      // Convert comma-separated string back to array of IDs
      const productIdsArray = Array.isArray(product_ids)
        ? product_ids
        : String(product_ids).split(",");
      const cleanedProductIds = productIdsArray
        .map((id: unknown) => String(id).trim())
        .filter((id: string) => id.length > 0);

      if (cleanedProductIds.length === 0) {
        return jsonResponse({ error: "No valid product ids provided" }, 400);
      }

      const uniqueProductIds = Array.from(new Set(cleanedProductIds));
      const { data: existingOrders } = await supabaseAdmin
        .from("orders")
        .select("product_id")
        .eq("user_id", user_id)
        .eq("payment_id", paymentId)
        .in("product_id", uniqueProductIds);

      const existingProductIds = new Set((existingOrders || []).map((row: any) => String(row.product_id)));
      const productIdsToInsert = uniqueProductIds.filter((id) => !existingProductIds.has(id));

      if (productIdsToInsert.length === 0) {
        return jsonResponse({ success: true, message: "Orders already synced" }, 200);
      }

      const { data: products, error: productsError } = await supabaseAdmin
        .from("products")
        .select("id, price, seller_id, title")
        .in("id", productIdsToInsert);
      if (productsError) throw productsError;
      if (!products || products.length === 0) {
        return jsonResponse({ error: "No valid products found for payment" }, 400);
      }

      const productPriceById = new Map<string, number>();
      const productSellerById = new Map<string, string | null>();
      const productTitleById = new Map<string, string>();
      for (const product of products) {
        const productId = String(product.id);
        productPriceById.set(productId, Number(product.price || 0));
        productSellerById.set(productId, product?.seller_id ? String(product.seller_id) : null);
        productTitleById.set(productId, String(product?.title || "Product"));
      }

      const expandedRows = productIdsToInsert
        .map((id: string) => ({
          productId: id,
          unitPrice: productPriceById.get(id) ?? 0,
          sellerId: productSellerById.get(id) ?? null,
          title: productTitleById.get(id) ?? "Product",
        }))
        .filter((row) => row.unitPrice >= 0);
      const subtotal = expandedRows.reduce((acc, row) => acc + row.unitPrice, 0);

      let couponDiscount = 0;
      let couponCodeToPersist: string | null = null;

      if (coupon_code && subtotal > 0) {
        const nowIso = new Date().toISOString();
        const { data: coupon, error: couponError } = await supabaseAdmin
          .from("coupons")
          .select("*")
          .eq("code", coupon_code)
          .eq("is_active", true)
          .or(`valid_until.is.null,valid_until.gte.${nowIso}`)
          .maybeSingle();

        if (!couponError && coupon) {
          const minCartValue = Number(coupon.min_cart_value || 0);
          const usageLimit = Number(coupon.usage_limit || 0);
          const usedCount = Number(coupon.used_count || 0);
          const usageAvailable = usageLimit <= 0 || usedCount < usageLimit;

          if (subtotal >= minCartValue && usageAvailable) {
            const percentDiscount = Number(coupon.discount_percent || 0) > 0
              ? (subtotal * Number(coupon.discount_percent)) / 100
              : 0;
            const flatDiscount = Number(coupon.discount_amount || 0);
            let rawDiscount = percentDiscount > 0 ? percentDiscount : flatDiscount;
            const maxDiscount = Number(coupon.max_discount || 0);
            if (maxDiscount > 0) rawDiscount = Math.min(rawDiscount, maxDiscount);
            couponDiscount = Math.min(subtotal, Math.max(0, Number(rawDiscount.toFixed(2))));
            couponCodeToPersist = coupon.code;

            await supabaseAdmin
              .from("coupons")
              .update({ used_count: usedCount + 1 })
              .eq("id", coupon.id);
          }
        }
      }

      const finalTotal = Math.max(0, Number((subtotal - couponDiscount).toFixed(2)));
      const discountRatio = subtotal > 0 ? couponDiscount / subtotal : 0;
      let allocatedDiscount = 0;

      // Allocate discount proportionally per item and fix rounding on the last row.
      const ordersToInsert = expandedRows.map((row, index) => {
        const unitPrice = Number(row.unitPrice.toFixed(2));
        let perItemDiscount = Number((unitPrice * discountRatio).toFixed(2));
        if (index === expandedRows.length - 1) {
          perItemDiscount = Number((couponDiscount - allocatedDiscount).toFixed(2));
        }
        perItemDiscount = Math.min(unitPrice, Math.max(0, perItemDiscount));
        allocatedDiscount = Number((allocatedDiscount + perItemDiscount).toFixed(2));
        const finalPrice = Number((unitPrice - perItemDiscount).toFixed(2));

        return {
          user_id: user_id,
          product_id: row.productId,
          payment_id: paymentId,
          status: "paid",
          unit_price: unitPrice,
          discount_amount: perItemDiscount,
          coupon_code: couponCodeToPersist,
          final_price: finalPrice,
          order_subtotal: subtotal,
          order_discount_total: couponDiscount,
          order_final_total: finalTotal,
        };
      });

      // Insert securely via admin client.
      // Fallback to legacy payload if schema migrations for coupon/pricing fields are not applied yet.
      const { error } = await supabaseAdmin.from("orders").insert(ordersToInsert);
      if (error) {
        const legacyOrdersToInsert = productIdsToInsert.map((pId: string) => ({
          user_id: user_id,
          product_id: pId,
          payment_id: paymentId,
          status: "paid",
        }));

        const { error: legacyError } = await supabaseAdmin.from("orders").insert(legacyOrdersToInsert);
        if (legacyError) throw legacyError;
      }

      // In-app push notifications for admin/seller dashboards.
      // Seller-owned products -> admin + seller, admin-owned products -> admin only.
      try {
        const sellerRecipientIds = Array.from(
          new Set(
            expandedRows
              .map((row) => row.sellerId)
              .filter((id): id is string => Boolean(id)),
          ),
        );

        const { data: adminUsers } = await supabaseAdmin
          .from("users")
          .select("id, fcm_token")
          .eq("role", "admin");

        const { data: sellerUsers } = sellerRecipientIds.length > 0
          ? await supabaseAdmin
            .from("users")
            .select("id, name, store_name, fcm_token")
            .in("id", sellerRecipientIds)
          : { data: [] as Array<{ id: string; name?: string | null; store_name?: string | null; fcm_token?: string | null }> };

        const adminTokens = (adminUsers || [])
          .map((row: any) => String(row?.fcm_token || "").trim())
          .filter((token: string) => token.length > 0);
        const sellerTokenRows = (sellerUsers || []).map((row: any) => ({
          id: String(row?.id || ""),
          token: String(row?.fcm_token || "").trim(),
          name: String(row?.store_name || row?.name || "Seller").trim() || "Seller",
        })).filter((row: { token: string }) => row.token.length > 0);

        const totalItems = expandedRows.length;
        const includesSellerProduct = sellerRecipientIds.length > 0;
        const title = includesSellerProduct ? "New Seller Order" : "New Admin Product Order";
        const orderedTitles = expandedRows.map((row) => row.title).filter(Boolean);
        const titlesPreview = orderedTitles.slice(0, 2).join(", ");
        const moreCount = Math.max(0, orderedTitles.length - 2);
        const itemText = titlesPreview
          ? `${titlesPreview}${moreCount > 0 ? ` +${moreCount} more` : ""}`
          : `${totalItems} item(s)`;
        const messageBody = includesSellerProduct
          ? `New order received: ${itemText}`
          : `Admin product order received: ${itemText}`;

        await sendFcmNotificationBatch(
          Array.from(new Set(adminTokens)),
          title,
          messageBody,
          {
            kind: "order_placed",
            target_role: "admin",
            payment_id: String(paymentId),
            order_items: String(totalItems),
            item_preview: itemText,
          },
        );

        if (sellerTokenRows.length > 0) {
          const sellerNameById = new Map<string, string>();
          for (const row of sellerTokenRows) {
            sellerNameById.set(row.id, row.name);
          }

          for (const sellerId of sellerRecipientIds) {
            const tokensForSeller = sellerTokenRows
              .filter((row: { id: string; token: string }) => row.id === sellerId)
              .map((row: { id: string; token: string }) => row.token);
            if (tokensForSeller.length === 0) continue;

            const sellerItemTitles = expandedRows
              .filter((row) => row.sellerId === sellerId)
              .map((row) => row.title);
            const sellerPreview = sellerItemTitles.slice(0, 2).join(", ");
            const sellerMoreCount = Math.max(0, sellerItemTitles.length - 2);
            const sellerItemText = sellerPreview
              ? `${sellerPreview}${sellerMoreCount > 0 ? ` +${sellerMoreCount} more` : ""}`
              : `${sellerItemTitles.length || totalItems} item(s)`;
            const sellerDisplayName = sellerNameById.get(sellerId) || "Seller";

            await sendFcmNotificationBatch(
              Array.from(new Set(tokensForSeller)),
              "New Order On Your Product",
              `${sellerDisplayName}, new order: ${sellerItemText}`,
              {
                kind: "order_placed",
                target_role: "seller",
                payment_id: String(paymentId),
                order_items: String(sellerItemTitles.length || totalItems),
                item_preview: sellerItemText,
              },
            );
          }
        }
      } catch (notifyErr) {
        console.error("Order notification dispatch failed", notifyErr);
      }
    }

    return jsonResponse({ success: true }, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown server error";
    return jsonResponse({ error: message }, 500);
  }
});
