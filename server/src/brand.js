// Assistant name shown in the UI. With Gemini behind the scenes the app must not say "Claude".
const FORMS = {
  gemini: [["Claude-a", "Gemini-yə"], ["Claude-dan", "Gemini-dən"], ["Claude-san", "Gemini-sən"], ["Claude-un", "Gemini-nin"], ["Claude", "Gemini"]],
  anthropic: [],
};
export function brand(html, provider) {
  let out = html;
  for (const [a, b] of FORMS[provider] || []) out = out.replace(new RegExp(`\\b${a}(?![-\\wəüöğışçƏÜÖĞIŞÇ])`, "g"), b);
  return out;
}
