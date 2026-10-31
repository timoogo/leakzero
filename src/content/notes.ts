import { startConversationTracking } from '../notes/detect';

// Snapchat Web only (manifest). Reports the open conversation to the Notes module; the protection
// script (./index.ts) never sends anything.
if (window.top === window) startConversationTracking(document);
