import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    // Caches the app shell so a flaky or dropped connection shows the offline
    // notice instead of a dead browser page. Registration is deferred until the
    // app is stable so it never competes with the first paint.
    //
    // Note there are deliberately no dataGroups in ngsw-config.json: Supabase
    // responses are never cached, because stale stock or price data would be
    // worse than a clear failure.
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
