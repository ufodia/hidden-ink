/**
 * Explainable scoring of text that looks like an instruction to an AI model.
 * Each rule contributes once; the matched phrases are returned so a reviewer
 * can see exactly why a text was flagged.
 */

export interface RuleHit {
  rule: string;
  label: string;
  weight: number;
  match: string;
}

export interface InstructionScore {
  score: number;
  level: 'instruction' | 'possible' | 'text';
  hits: RuleHit[];
}

interface Rule {
  rule: string;
  label: string;
  weight: number;
  pattern: RegExp;
}

export const RULES: Rule[] = [
  {
    rule: 'override',
    label: 'Tries to override earlier instructions',
    weight: 50,
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|all|any|your|the|system)\b[^.\n]{0,25}?\b(?:instructions?|prompts?|rules?|directions?|guidelines?|messages?)\b/i,
  },
  {
    rule: 'addresses-ai',
    label: 'Speaks directly to an AI',
    weight: 30,
    // OCR often reads "AI" as "Al", so both spellings count.
    pattern:
      /\b(?:if you are|as|dear|attention|note to|hey|to the|to all)\s+(?:an?\s+|the\s+)?(?:A[Il]|A\.I\.|LLM|language model|assistant|agent|chatbot|bot|model|ChatGPT|Claude|Gemini|Copilot|GPT)s?\b|\b(?:A[Il]|LLM|assistant|agent|model)s?\s*(?:reading|processing|viewing|analy[sz]ing) this\b|\b(?:agent|assistant|AI|model|LLM)\s+(?:task|instructions?|note|command|directive|order)s?\s*:/i,
  },
  {
    rule: 'role',
    label: 'Redefines the model’s role or rules',
    weight: 30,
    pattern:
      /\byou are (?:now )?(?:an?|the|my)\b[^.\n]{0,40}\b(?:assistant|AI|agent|model|bot|GPT|LLM)\b|\b(?:system prompt|system message|developer mode|jailbreak|DAN mode|new instructions|updated instructions)\b|(?:^|[\n.!]\s*)(?:SYSTEM|ADMIN|DEVELOPER|INSTRUCTIONS?)\s*:/i,
  },
  {
    rule: 'account',
    label: 'Asks to use the user’s account or credentials',
    weight: 35,
    pattern:
      /\b(?:sign|log)\s?in\b[^.\n]{0,30}?\b(?:user'?s?|their|account|credentials?|password)\b|\benter\b[^.\n]{0,25}?\b(?:password|credentials?|card number|one-time code|OTP|PIN)\b/i,
  },
  {
    rule: 'conceal',
    label: 'Asks to hide something from the user',
    weight: 35,
    pattern:
      /\b(?:do not|don't|dont|never|without)\b[^.\n]{0,25}?\b(?:tell|mention|reveal|inform|show|alert|notify|disclose)(?:ing)?\b[^.\n]{0,25}?\b(?:the user|user|human|anyone|them)\b/i,
  },
  {
    rule: 'exfiltrate',
    label: 'Asks to send data somewhere',
    weight: 40,
    pattern:
      /\b(?:send|email|e-mail|forward|upload|post|share|leak|copy|transfer)\b[^.\n]{0,50}?\b(?:passwords?|credentials?|tokens?|api keys?|cookies?|session|conversation|chat history|history|contacts|emails?|personal (?:data|information)|files?|money|funds|crypto|bitcoin|wallet)\b/i,
  },
  {
    rule: 'act',
    label: 'Asks the agent to take an action',
    weight: 25,
    pattern:
      /\b(?:navigate|go|browse|redirect)\s+to\b|\bopen (?:the )?(?:link|url|page|website|site|https?:\/\/|www\.)|\bclick (?:on )?(?:the )?\w+|\b(?:download|install|run|execute)\b[^.\n]{0,30}?\b(?:file|script|command|program|code|app|extension)\b|\b(?:buy|purchase|pay|book|subscribe|sign up)\b[^.\n]{0,20}\bnow\b/i,
  },
  {
    rule: 'manipulate',
    label: 'Tries to steer a judgement or rating',
    weight: 30,
    pattern:
      /\b(?:give|rate|rank|score|grade|review)\b[^.\n]{0,30}?\b(?:positive|highest|high|top|best|5 stars?|five stars?|10\/10|excellent|favou?rabl[ey])\b|\b(?:recommend|approve|accept|hire|shortlist|select)\b[^.\n]{0,20}?\b(?:this|me|the candidate|this candidate|this paper|this product|this applicant)\b/i,
  },
  {
    rule: 'output',
    label: 'Dictates what the model should say',
    weight: 20,
    pattern:
      /\b(?:respond|reply|answer|say|output|print|write|summari[sz]e)\b[^.\n]{0,20}?\b(?:only|with|exactly|that|as)\b[^.\n]{0,40}/i,
  },
  {
    rule: 'link',
    label: 'Contains a link or address',
    weight: 10,
    pattern:
      /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+|\b[\w.-]+\.(?:com|net|org|io|xyz|ru|cn|top|app|dev)\/[^\s]*|\b[\w.+-]+@[\w-]+\.[\w.]+\b/i,
  },
  {
    rule: 'urgency',
    label: 'Uses urgency or authority',
    weight: 10,
    pattern:
      /\b(?:important|urgent|immediately|mandatory|critical|must|required|priority|official|administrator|admin)\b/i,
  },
];

export function scoreInstruction(text: string): InstructionScore {
  const hits: RuleHit[] = [];
  for (const rule of RULES) {
    const m = rule.pattern.exec(text);
    if (m) hits.push({ rule: rule.rule, label: rule.label, weight: rule.weight, match: m[0].trim() });
  }
  const score = Math.min(
    100,
    hits.reduce((n, h) => n + h.weight, 0),
  );
  return { score, level: score >= 50 ? 'instruction' : score >= 25 ? 'possible' : 'text', hits };
}
