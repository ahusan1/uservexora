import { supabase } from './supabase';
import { toast } from 'react-hot-toast';

/**
 * Compress image using Canvas API (browser-native, no external dependency)
 * Adaptive compression with quality-first strategy to avoid blurry output.
 */
export const compressImage = async (
  file: File,
  maxWidth: number = 896,
  maxHeight: number = 896,
  quality: number = 0.82
): Promise<Blob> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const img = new Image();
      
      img.onload = async () => {
        // User-preferred balance window.
        const TARGET_MIN_BYTES = 20 * 1024;
        const TARGET_MAX_BYTES = 30 * 1024;
        const MIN_QUALITY = 0.28;
        const MAX_QUALITY = 0.95;

        const detectEncodeSupport = async (mimeType: 'image/avif' | 'image/webp' | 'image/jpeg'): Promise<boolean> => {
          try {
            const probe = document.createElement('canvas');
            probe.width = 2;
            probe.height = 2;
            const blob = await new Promise<Blob | null>((res) => {
              probe.toBlob((b) => res(b), mimeType, 0.8);
            });
            return !!blob && blob.type === mimeType;
          } catch {
            return false;
          }
        };

        const scaleAndDraw = (limitWidth: number, limitHeight: number): HTMLCanvasElement => {
          // Progressive downscale reduces blur compared to one-step shrinking.
          const sourceCanvas = document.createElement('canvas');
          const sourceCtx = sourceCanvas.getContext('2d');
          if (!sourceCtx) {
            throw new Error('Failed to get canvas context');
          }

          sourceCanvas.width = Math.max(1, Math.round(img.width));
          sourceCanvas.height = Math.max(1, Math.round(img.height));
          sourceCtx.imageSmoothingEnabled = true;
          sourceCtx.imageSmoothingQuality = 'high';
          sourceCtx.drawImage(img, 0, 0, sourceCanvas.width, sourceCanvas.height);

          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > limitWidth) {
              height = (height * limitWidth) / width;
              width = limitWidth;
            }
          } else {
            if (height > limitHeight) {
              width = (width * limitHeight) / height;
              height = limitHeight;
            }
          }

          const targetW = Math.max(1, Math.round(width));
          const targetH = Math.max(1, Math.round(height));

          let currentCanvas = sourceCanvas;
          let currentW = sourceCanvas.width;
          let currentH = sourceCanvas.height;

          // Reduce by half repeatedly until close to target.
          while (currentW * 0.5 > targetW && currentH * 0.5 > targetH) {
            const nextCanvas = document.createElement('canvas');
            nextCanvas.width = Math.max(targetW, Math.floor(currentW * 0.5));
            nextCanvas.height = Math.max(targetH, Math.floor(currentH * 0.5));
            const nextCtx = nextCanvas.getContext('2d');
            if (!nextCtx) {
              throw new Error('Failed to get canvas context');
            }
            nextCtx.imageSmoothingEnabled = true;
            nextCtx.imageSmoothingQuality = 'high';
            nextCtx.drawImage(currentCanvas, 0, 0, nextCanvas.width, nextCanvas.height);
            currentCanvas = nextCanvas;
            currentW = nextCanvas.width;
            currentH = nextCanvas.height;
          }

          const finalCanvas = document.createElement('canvas');
          finalCanvas.width = targetW;
          finalCanvas.height = targetH;
          const finalCtx = finalCanvas.getContext('2d');
          if (!finalCtx) {
            throw new Error('Failed to get canvas context');
          }
          finalCtx.imageSmoothingEnabled = true;
          finalCtx.imageSmoothingQuality = 'high';
          finalCtx.drawImage(currentCanvas, 0, 0, targetW, targetH);

          return finalCanvas;
        };

        const toEncodedBlob = (canvas: HTMLCanvasElement, mimeType: 'image/avif' | 'image/webp' | 'image/jpeg', q: number): Promise<Blob> => {
          return new Promise((res, rej) => {
            canvas.toBlob(
              (blob) => {
                if (blob) {
                  res(blob);
                } else {
                  rej(new Error('Failed to compress image'));
                }
              },
              mimeType,
              q
            );
          });
        };

        try {
          // Step down dimensions gradually to keep details while controlling final size.
          const dimensionPresets = [
            [1024, 1024],
            [maxWidth, maxHeight],
            [768, 768],
            [640, 640],
            [560, 560],
            [512, 512],
            [448, 448],
            [384, 384]
          ] as const;

          const avifSupported = await detectEncodeSupport('image/avif');
          const webpSupported = await detectEncodeSupport('image/webp');
          const mimePriority: Array<'image/avif' | 'image/webp' | 'image/jpeg'> = avifSupported
            ? ['image/avif', 'image/webp', 'image/jpeg']
            : webpSupported
              ? ['image/webp', 'image/jpeg']
              : ['image/jpeg'];

          type Candidate = {
            blob: Blob;
            width: number;
            height: number;
            quality: number;
          };

          let bestInRange: Candidate | null = null;
          let bestUnderMax: Candidate | null = null;
          let nearestAny: Candidate | null = null;
          const targetCenter = (TARGET_MIN_BYTES + TARGET_MAX_BYTES) / 2;

          const candidateScore = (c: Candidate) => (c.width * c.height) * c.quality;

          for (const mimeType of mimePriority) {
            let hitInRangeForMime = false;

            for (const [w, h] of dimensionPresets) {
              const canvas = scaleAndDraw(w, h);

              // Find the highest possible quality that still stays under max size.
              let lowQ = MIN_QUALITY;
              let highQ = MAX_QUALITY;
              let bestForPreset: Candidate | null = null;

              for (let i = 0; i < 12; i++) {
                const q = i === 0 ? Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, quality)) : (lowQ + highQ) / 2;
                const blob = await toEncodedBlob(canvas, mimeType, q);

                // If browser silently encoded to another format (often PNG), skip this mime path.
                if (blob.type !== mimeType) {
                  break;
                }

                const size = blob.size;

                if (!nearestAny || Math.abs(size - targetCenter) < Math.abs(nearestAny.blob.size - targetCenter)) {
                  nearestAny = { blob, width: canvas.width, height: canvas.height, quality: q };
                }

                if (size <= TARGET_MAX_BYTES) {
                  bestForPreset = { blob, width: canvas.width, height: canvas.height, quality: q };
                  lowQ = q;
                } else {
                  highQ = q;
                }

                if (size > TARGET_MAX_BYTES) {
                  highQ = q;
                } else if (size < TARGET_MIN_BYTES) {
                  lowQ = q;
                } else {
                  bestForPreset = { blob, width: canvas.width, height: canvas.height, quality: q };
                  hitInRangeForMime = true;
                  break;
                }
              }

              if (bestForPreset) {
                const size = bestForPreset.blob.size;
                if (size >= TARGET_MIN_BYTES && size <= TARGET_MAX_BYTES) {
                  if (!bestInRange || candidateScore(bestForPreset) > candidateScore(bestInRange)) {
                    bestInRange = bestForPreset;
                  }
                }

                if (!bestUnderMax || candidateScore(bestForPreset) > candidateScore(bestUnderMax)) {
                  bestUnderMax = bestForPreset;
                }
              }

              if (hitInRangeForMime) {
                break;
              }
            }

            if (hitInRangeForMime) {
              break;
            }
          }

          const finalCandidate = bestInRange || bestUnderMax || nearestAny;

          if (!finalCandidate) {
            reject(new Error('Failed to compress image'));
            return;
          }

          resolve(finalCandidate.blob);
        } catch (err) {
          reject(err instanceof Error ? err : new Error('Failed to compress image'));
        }
      };

      img.onerror = () => {
        reject(new Error('Failed to load image'));
      };

      img.src = e.target?.result as string;
    };

    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };

    reader.readAsDataURL(file);
  });
};

/**
 * Upload compressed image to Supabase storage
 * Returns the public URL of the uploaded image
 */
export const uploadImageToSupabase = async (
  file: File,
  folder: string = 'product-images'
): Promise<string | null> => {
  try {
    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return null;
    }

    // Check file size (max 10MB before compression)
    const maxSizeBeforeCompression = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSizeBeforeCompression) {
      toast.error('File size too large (max 10MB)');
      return null;
    }

    // Show loading toast
    const loadingToast = toast.loading('Compressing & uploading image...');

    // Compress the image
    const compressedBlob = await compressImage(file);
    const isAvif = compressedBlob.type === 'image/avif';
    const isWebp = compressedBlob.type === 'image/webp';
    const isJpeg = compressedBlob.type === 'image/jpeg';
    const safeBlob = isAvif || isWebp || isJpeg ? compressedBlob : await new Promise<Blob>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Failed to convert image format'));
            return;
          }
          ctx.drawImage(img, 0, 0);
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Failed to convert image format'));
          }, 'image/jpeg', 0.82);
        };
        img.onerror = () => reject(new Error('Failed to parse compressed image'));
        img.src = e.target?.result as string;
      };
      reader.onerror = () => reject(new Error('Failed to read compressed image'));
      reader.readAsDataURL(compressedBlob);
    });
    
    // Create a new file from the compressed blob
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const extension = safeBlob.type === 'image/avif' ? 'avif' : safeBlob.type === 'image/webp' ? 'webp' : 'jpg';
    const contentType = safeBlob.type === 'image/avif' ? 'image/avif' : safeBlob.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const fileName = `${folder}/${timestamp}-${randomStr}.${extension}`;

    // Upload to Supabase storage
    const { data, error } = await supabase.storage
      .from('product-storage')
      .upload(fileName, safeBlob, {
        cacheControl: '3600',
        upsert: false,
        contentType
      });

    if (error) {
      toast.dismiss(loadingToast);
      toast.error(`Upload failed: ${error.message}`);
      return null;
    }

    // Get public URL
    const { data: publicData } = supabase.storage
      .from('product-storage')
      .getPublicUrl(fileName);

    const originalSizeKB = (file.size / 1024).toFixed(2);
    const compressedSizeKB = (safeBlob.size / 1024).toFixed(2);
    const reduction = (((file.size - safeBlob.size) / file.size) * 100).toFixed(1);

    toast.dismiss(loadingToast);
    toast.success(
      `Image uploaded! ${originalSizeKB}KB → ${compressedSizeKB}KB (${reduction}% smaller)`
    );

    return publicData.publicUrl;
  } catch (error: any) {
    console.error('Image upload error:', error);
    toast.error(error.message || 'Failed to upload image');
    return null;
  }
};

/**
 * Delete image from Supabase storage
 */
export const deleteImageFromSupabase = async (imageUrl: string): Promise<boolean> => {
  try {
    // Extract file path from public URL
    const urlParts = imageUrl.split('/product-storage/');
    if (urlParts.length !== 2) {
      console.warn('Invalid image URL format');
      return false;
    }

    const filePath = decodeURIComponent(urlParts[1]);

    const { error } = await supabase.storage
      .from('product-storage')
      .remove([filePath]);

    if (error) {
      console.warn('Failed to delete image:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.warn('Error deleting image:', error);
    return false;
  }
};

/**
 * Format file size for display
 */
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};
