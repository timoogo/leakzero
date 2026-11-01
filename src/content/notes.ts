import { startConversationTracking } from '../notes/detect';
import { startMessageSelection } from '../notes/selection';

// Snapchat Web only (manifest). Reports the open conversation to the Notes module and, in selection
// mode, the messages selected in it; the protection script (./index.ts) never sends anything.
if (window.top === window) {
  startConversationTracking(document);
  startMessageSelection(document);
}
