import { supabase } from './supabase.ts';
import type { Order } from '../types.ts';

interface DownloadAccessOptions {
  ignoreLimit?: boolean;
}

const toNonNegativeInteger = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
};

// Check if the order's license is active
export const isLicenseActive = (order: Order | null): boolean => {
  return order?.license_active !== false;
};

// Get the maximum allowed downloads for this specific order
export const getDownloadLimit = (order: Order | null, options?: DownloadAccessOptions): number | null => {
  if (options?.ignoreLimit) return null;
  return toNonNegativeInteger(order?.download_limit);
};

// Get how many times the user has already downloaded this order
export const getDownloadCount = (order: Order | null): number => {
  return toNonNegativeInteger(order?.download_count) ?? 0;
};

// Calculate remaining downloads
export const getRemainingDownloads = (order: Order | null, options?: DownloadAccessOptions): number | null => {
  const limit = getDownloadLimit(order, options);
  if (limit === null) return null; // null means unlimited
  return Math.max(limit - getDownloadCount(order), 0);
};

// Main function to check if the user is allowed to download the order
export const canOrderDownload = (order: Order | null, options?: DownloadAccessOptions): { allowed: boolean; reason?: string } => {
  if (!order) return { allowed: false, reason: 'Order not found.' };
  if (!isLicenseActive(order)) {
    return { allowed: false, reason: 'License revoked for this order. Contact support.' };
  }

  const remaining = getRemainingDownloads(order, options);
  if (remaining !== null && remaining <= 0) {
    return { allowed: false, reason: 'Download limit reached for this specific order.' };
  }

  return { allowed: true };
};

// Securely resolve the download URL (handles both external links and Supabase Secure Storage)
export const resolveDownloadUrl = async (
  fileUrl: string,
  ttlSeconds = 120,
): Promise<{ url: string | null; error: string | null }> => {
  const cleanFileUrl = String(fileUrl || '').trim();
  if (!cleanFileUrl) return { url: null, error: 'Download link is being prepared...' };

  if (/^https?:\/\//i.test(cleanFileUrl)) {
    return { url: cleanFileUrl, error: null };
  }

  const { data, error } = await supabase.storage
    .from('secure_assets')
    .createSignedUrl(cleanFileUrl.replace(/^\/+/, ''), ttlSeconds);

  if (error || !data?.signedUrl) {
    return { url: null, error: 'Download unavailable right now. Please contact support.' };
  }

  return { url: data.signedUrl, error: null };
};

// Function to increment the download count in the database
export const incrementOrderDownloadCount = async (
  orderId: string,
  currentCount: number,
  options?: DownloadAccessOptions,
): Promise<{ ok: boolean; newCount: number }> => {
  const ignoreLimit = options?.ignoreLimit === true;

  if (!ignoreLimit) {
    const { data: rpcResult, error: rpcError } = await supabase
      .rpc('increment_order_download_count', { p_order_id: orderId });

    if (!rpcError && rpcResult) {
      const payload = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
      if (payload && typeof payload === 'object') {
        const ok = payload.ok === true;
        const newCount = toNonNegativeInteger(payload.new_count) ?? (toNonNegativeInteger(currentCount) ?? 0);
        return { ok, newCount };
      }
    }
  }

  const fallbackCount = toNonNegativeInteger(currentCount) ?? 0;
  let latestCount = fallbackCount;

  const { data: orderRow } = await supabase
    .from('orders')
    .select('download_count,download_limit,license_active')
    .eq('id', orderId)
    .maybeSingle();

  if (orderRow) {
    latestCount = toNonNegativeInteger(orderRow.download_count) ?? 0;
    const limit = toNonNegativeInteger(orderRow.download_limit);
    const licenseActive = orderRow.license_active !== false;

    if (!licenseActive) {
      return { ok: false, newCount: latestCount };
    }

    if (!ignoreLimit && limit !== null && latestCount >= limit) {
      return { ok: false, newCount: latestCount };
    }
  }

  const nextCount = latestCount + 1;
  const { data: updatedRow, error } = await supabase
    .from('orders')
    .update({ download_count: nextCount })
    .eq('id', orderId)
    .select('id,download_count')
    .maybeSingle();

  if (error || !updatedRow) {
    return { ok: false, newCount: latestCount };
  }

  const persistedCount = toNonNegativeInteger(updatedRow.download_count) ?? nextCount;
  return { ok: true, newCount: persistedCount };
};

export const incrementDownloadCountByUserProduct = async (
  userId: string,
  productId: string,
  fallbackCurrentCount = 0,
  options?: DownloadAccessOptions,
): Promise<{ ok: boolean; newCount: number }> => {
  const { data: orderRow, error } = await supabase
    .from('orders')
    .select('id,download_count')
    .eq('user_id', userId)
    .eq('product_id', productId)
    .eq('status', 'paid')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !orderRow?.id) {
    const safeFallback = toNonNegativeInteger(fallbackCurrentCount) ?? 0;
    return { ok: false, newCount: safeFallback };
  }

  const liveCount = toNonNegativeInteger(orderRow.download_count) ?? (toNonNegativeInteger(fallbackCurrentCount) ?? 0);
  return incrementOrderDownloadCount(orderRow.id, liveCount, options);
};
