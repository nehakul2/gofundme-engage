// Spots "start a fundraiser for X" style messages in the chat and returns X (possibly empty).
// Returns null for ordinary searches, so "wildfire" or "raise awareness" still just search.
// A start verb must come BEFORE the noun: "start a fundraiser for X" yes, "do we have a fundraiser for X" no.
const WANTS = /\b(start|starting|create|creating|begin|launch|open|set up|setup|make|raise)\b[^.?!]*\b(fundraisers?|fund[\s-]raisers?|campaigns?|fundraising)\b/i;
const LEAD = /^\s*(?:(?:hi|hey|hello)[,!.\s]+)?(?:(?:i|we)\s+(?:want|would like|need|wish)\s+to\s+|(?:can|could)\s+(?:i|we)\s+|let'?s\s+|please\s+)*(?:start|starting|create|creating|begin|launch|open|set up|setup|make|raise)\s+(?:(?:a|an|my|our|the|new)\s+)*(?:(?:fundraisers?|fund[\s-]raisers?|campaigns?|fundraising)\s*)?(?:(?:page|drive)\s+)?(?:(?:for|about|to\s+(?:help|support|raise\s+money\s+for)|called|named|on)\s+)?/i;

export function startIntent(raw: string): { topic: string } | null {
  const t = raw.trim();
  if (!WANTS.test(t)) return null;
  const topic = t.replace(LEAD, '').replace(/^(?:a|an|the)\s+(?:fundraisers?|campaigns?)\s+(?:for|about|to\s+support)\s+/i, '').replace(/[.!?]+$/, '').replace(/^(?:the|a|an)\s+/i, '').trim();
  return { topic: topic === t ? '' : topic };
}

export const titleCase1 = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
