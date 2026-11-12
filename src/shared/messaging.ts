export async function requestArc(message: { type: string; [key: string]: unknown }) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}
