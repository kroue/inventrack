import { Injectable, signal } from '@angular/core';

/**
 * Tracks whether the browser currently has a network connection.
 *
 * This exists so the app can fail honestly rather than silently: with no
 * network there is no way to record a sale, because stock deduction, FEFO batch
 * allocation and the row locks that prevent concurrent-checkout races all live
 * on the server. Rather than let a cashier build a cart that cannot be
 * committed, the UI says so and points them at the Excel sales log.
 *
 * `navigator.onLine` only reports whether the device has *a* connection, not
 * whether Supabase is reachable — a captive portal or a dead uplink still reads
 * as online. It is therefore a fast negative signal, not a guarantee, so
 * `reportRequestFailure()` lets a failed call mark the app offline too.
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly _isOnline = signal<boolean>(
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  readonly isOnline = this._isOnline.asReadonly();

  constructor() {
    if (typeof window === 'undefined') return;

    window.addEventListener('online', () => this._isOnline.set(true));
    window.addEventListener('offline', () => this._isOnline.set(false));
  }

  /**
   * Called when a request fails in a way that looks like a lost connection, so
   * the banner appears even though the browser still believes it is online.
   */
  reportRequestFailure(error: unknown) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this._isOnline.set(false);
      return;
    }

    const message = String((error as { message?: string })?.message ?? error ?? '');
    if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) {
      this._isOnline.set(false);
    }
  }

  /** Called when a request succeeds, clearing a failure-derived offline state. */
  reportRequestSuccess() {
    if (typeof navigator === 'undefined' || navigator.onLine) {
      this._isOnline.set(true);
    }
  }
}
