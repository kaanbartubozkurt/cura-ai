/** Loads PayPal's JavaScript SDK once, for the PayPal and card buttons on /billing/checkout. */

export interface PayPalButtonsActions {
  order?: unknown;
}

export interface PayPalButtonsOptions {
  fundingSource?: string;
  style?: Record<string, string | number | boolean>;
  createOrder: () => Promise<string>;
  onApprove: (data: { orderID: string }) => Promise<void>;
  onCancel?: (data: { orderID?: string }) => void;
  onError?: (error: unknown) => void;
}

export interface PayPalButtonsInstance {
  isEligible: () => boolean;
  render: (container: HTMLElement) => Promise<void>;
  close: () => Promise<void>;
}

export interface PayPalNamespace {
  Buttons: (options: PayPalButtonsOptions) => PayPalButtonsInstance;
  FUNDING: { PAYPAL: string; CARD: string };
}

declare global {
  interface Window {
    paypal?: PayPalNamespace;
  }
}

let loading: Promise<PayPalNamespace> | null = null;

export function loadPayPal(clientId: string, currency = 'USD'): Promise<PayPalNamespace> {
  if (window.paypal) return Promise.resolve(window.paypal);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      'client-id': clientId,
      currency,
      intent: 'capture',
      components: 'buttons',
      'enable-funding': 'card',
      'disable-funding': 'paylater,venmo,credit',
    });
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?${params}`;
    script.async = true;
    script.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PayPal did not load')));
    script.onerror = () => { loading = null; reject(new Error('PayPal did not load')); };
    document.head.appendChild(script);
  });
  return loading;
}
