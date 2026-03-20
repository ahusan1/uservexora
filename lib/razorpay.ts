let razorpayLoaderPromise: Promise<boolean> | null = null;

export const ensureRazorpayLoaded = async (): Promise<boolean> => {
  if (typeof window === 'undefined') return false;

  if ((window as any).Razorpay) {
    return true;
  }

  if (razorpayLoaderPromise) {
    return razorpayLoaderPromise;
  }

  razorpayLoaderPromise = new Promise<boolean>((resolve) => {
    const existingScript = document.querySelector<HTMLScriptElement>('script[data-razorpay-sdk="true"]');

    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(Boolean((window as any).Razorpay)), { once: true });
      existingScript.addEventListener('error', () => resolve(false), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.dataset.razorpaySdk = 'true';

    script.onload = () => resolve(Boolean((window as any).Razorpay));
    script.onerror = () => resolve(false);

    document.head.appendChild(script);
  });

  const loaded = await razorpayLoaderPromise;

  if (!loaded) {
    razorpayLoaderPromise = null;
  }

  return loaded;
};
