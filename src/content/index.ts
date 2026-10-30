import { startProtection } from './protection';

// Runs at document_start (manifest), or in tabs already open when the extension is installed or
// updated (injected by the background script).
startProtection(document);
