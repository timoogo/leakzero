import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotesCommandError, sendNotesCommand } from '../src/notes/messages';
import { fakeChrome } from './helpers/chrome';

afterEach(() => vi.unstubAllGlobals());

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

describe('Notes commands', () => {
  it('returns the result of the service worker', async () => {
    const storage = fakeChrome();
    storage.api.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
      sendResponse({ ok: true, result: 42 });
      return true;
    });
    expect(await sendNotesCommand({ type: 'notes:save' }, storage.api)).toBe(42);
  });

  it('retries once when the service worker is restarting', async () => {
    const storage = fakeChrome();
    vi.mocked(storage.api.runtime.sendMessage)
      .mockRejectedValueOnce(new Error(NO_RECEIVER))
      .mockResolvedValueOnce({ ok: true, result: 'ok' });
    expect(await sendNotesCommand({ type: 'notes:save' }, storage.api)).toBe('ok');
  });

  it('explains what to do when no service worker answers, instead of Chrome’s message', async () => {
    const storage = fakeChrome();
    const error = await sendNotesCommand({ type: 'notes:save' }, storage.api).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NotesCommandError);
    expect((error as Error).message).toContain('rechargez LeakZero');
    expect(storage.api.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('reports the failure the service worker returns, without retrying', async () => {
    const storage = fakeChrome();
    storage.api.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
      sendResponse({ ok: false, error: 'QUOTA_BYTES quota exceeded' });
      return true;
    });
    await expect(sendNotesCommand({ type: 'notes:save' }, storage.api)).rejects.toThrow('QUOTA');
    expect(storage.api.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('says so when the extension was reloaded under the page', async () => {
    const storage = fakeChrome();
    storage.invalidate();
    await expect(sendNotesCommand({ type: 'notes:save' }, storage.api)).rejects.toThrow('Rechargez cette page');
  });
});
