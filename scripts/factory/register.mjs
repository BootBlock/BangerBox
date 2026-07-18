/** Install the factory generator's TS/alias resolution hook (spec §9.8). See resolve-hook.mjs. */
import { register } from 'node:module';

register('./resolve-hook.mjs', import.meta.url);
