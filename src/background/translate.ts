export async function translateText(text: string, targetLang: string, sourceLang = 'auto') {
  const trimmed = text.trim();
  if (!trimmed) {
    return { translatedText: '', detectedSourceLang: sourceLang };
  }

  try {
    const endpoint = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(
      sourceLang
    )}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(trimmed)}`;

    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`Translation HTTP status ${response.status}`);
    }
    const data = await response.json();
    // data[0] contains array of [translatedSegment, originalSegment, ...]
    const translatedSegments: string[] = [];
    if (Array.isArray(data?.[0])) {
      for (const seg of data[0]) {
        if (Array.isArray(seg) && typeof seg[0] === 'string') {
          translatedSegments.push(seg[0]);
        }
      }
    }
    const detectedSourceLang = typeof data?.[2] === 'string' ? data[2] : sourceLang;
    return {
      translatedText: translatedSegments.join('') || trimmed,
      detectedSourceLang
    };
  } catch (err) {
    console.error('Translation error:', err);
    return {
      translatedText: `[Translation unavailable] ${trimmed}`,
      detectedSourceLang: sourceLang,
      error: String(err)
    };
  }
}
