/** Saves `blob` as `name` through the browser's download, without the `downloads` permission. */
export function downloadFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Revoked later: the download starts asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
