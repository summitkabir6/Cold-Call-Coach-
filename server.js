require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const twilio = require("twilio");

// ===== INIT CLIENTS =====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ===== EXPRESS SETUP =====
const app = express();
const PORT = 3000;

app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.send("Cold Call Coach webhook server running");
});

// ===== HELPERS =====
function normalizePersonaName(persona) {
  if (!persona || typeof persona !== "string") return "";

  const p = persona.toLowerCase();

  if (p.includes("morgan")) return "Morgan (CFO)";
  if (p.includes("jamie")) return "Jamie (CEO)";
  if (p.includes("linda")) return "Linda (Gatekeeper)";
  if (p.includes("sarah")) return "Sarah (Marketing Manager)";
  if (p.includes("dana")) return "Dana (VP of Sales)";
  if (p.includes("selector")) return "";

  return persona;
}

function extractFinalAgentName(call) {
  let agentName = call.agent_name || "";

  if (Array.isArray(call.tool_calls) && call.tool_calls.length > 0) {
    const agentSwaps = call.tool_calls.filter((t) => t.type === "agent_swap");
    if (agentSwaps.length > 0) {
      const lastSwap = agentSwaps[agentSwaps.length - 1];
      agentName = lastSwap.name || agentName;
    }
  }

  return agentName;
}

function hasPersonaBeenChosen(persona) {
  if (!persona || typeof persona !== "string") return false;

  const p = persona.toLowerCase().trim();

  if (!p) return false;
  if (p.includes("selector")) return false;
  if (p.includes("router")) return false;
  if (p.includes("menu")) return false;

  return true;
}

function cleanTranscript(transcript) {
  if (!transcript || typeof transcript !== "string") return "";
  return transcript.replace(/\s+/g, " ").trim();
}

function callerSaidAnythingMeaningful(transcript) {
  const cleaned = cleanTranscript(transcript);
  if (!cleaned) return false;

  const lower = cleaned.toLowerCase();

  if (lower.length < 8) return false;
  if (!/[a-z]/i.test(lower)) return false;

  const ultraWeakExact = [
    "hello",
    "hi",
    "hey",
    "yeah",
    "yep",
    "yo",
    "okay",
    "ok",
    "hmm",
    "uh",
    "um",
  ];

  if (ultraWeakExact.includes(lower)) return false;

  return true;
}

function formatNoPersonaSms() {
  return (
    `Cold Call Coach\n` +
    `No persona was selected on this call, so no scoring was completed.\n\n` +
    `Call back, choose a persona, and try a full practice round.`
  );
}

function formatNoSpeechSms(persona) {
  const personaLabel = persona || "Selected persona";

  return (
    `Cold Call Coach\n` +
    `Persona: ${personaLabel}\n` +
    `No usable caller speech was detected, so this call could not be graded.\n\n` +
    `Try again and speak with the persona to receive a score and feedback.`
  );
}

function formatCoachingSms(persona, analysis) {
  const personaLabel = persona || "Prospect";
  const score = Number(analysis.score || 0);
  const percent = Math.round((score / 60) * 100);

  const strengths = Array.isArray(analysis.strengths)
    ? analysis.strengths.slice(0, 1)
    : [];

  const improvements = Array.isArray(analysis.improvements)
    ? analysis.improvements.slice(0, 2)
    : [];

  const tip = analysis.coaching_tip || "Lead with a clear outcome.";

  const conductFlag = analysis.conduct_flag || "clean";
  const conductNote = analysis.conduct_note || "";

  let sms = `Cold Call Coach:\n`;
  sms += `Persona: ${personaLabel}\n`;
  sms += `Score: ${score}/60 | ${percent}%\n`;

  if (conductFlag !== "clean" && conductNote) {
    sms += `\nNote:\n- ${shorten(conductNote, 90)}\n`;
  }

  if (strengths.length > 0) {
    sms += `\nWhat worked:\n- ${shorten(strengths[0], 90)}\n`;
  }

  if (improvements.length > 0) {
    sms += `\nFix next:\n- ${shorten(improvements[0], 105)}`;
    if (improvements.length > 1) {
      sms += `\n- ${shorten(improvements[1], 105)}`;
    }
    sms += `\n`;
  }

  sms += `\nTip: ${shorten(tip, 90)}\n`;
  sms += `Run it again and beat your score.`;

  if (sms.length > 700) {
    sms =
      `Cold Call Coach:\n` +
      `Persona: ${personaLabel}\n` +
      `Score: ${score}/60 | ${percent}%\n` +
      `\nWhat worked:\n- ${shorten(strengths[0] || "You made a real attempt.", 80)}\n` +
      `\nFix next:\n- ${shorten(improvements[0] || "Lead with a clearer value statement.", 90)}\n` +
      `\nTip: ${shorten(tip, 75)}\n` +
      `Run it again and beat your score.`;
  }

  return sms;
}

function shorten(text, maxLength = 100) {
  if (!text || typeof text !== "string") return "";

  const cleaned = text.replace(/\s+/g, " ").trim();

  if (cleaned.length <= maxLength) return cleaned;

  return cleaned.slice(0, maxLength - 3).trim() + "...";
}

async function sendSmsBody(to, body) {
  try {
    const response = await twilioClient.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });

    console.log("SMS sent:", response.sid);
  } catch (error) {
    console.error("SMS failed:", error.message);
  }
}

// ===== ANALYSIS FUNCTION =====
async function analyzeColdCall(transcript, persona) {
  const prompt = `
You are a strict but fair cold call evaluator for a B2B SaaS cold call training simulator.

Your job is to evaluate ONLY the actual conversation with the final prospect persona.

==================================================
IMPORTANT FILTERING RULES
==================================================

- Ignore any selector, routing, menu, transfer, or persona-selection conversation.
- Ignore anything before the actual prospect joins.
- Evaluate ONLY the seller’s performance with the final persona.
- If the transcript contains multiple phases, focus only on the real conversation.

FINAL PROSPECT PERSONA:
${persona}

TRANSCRIPT:
${transcript}

==================================================
SCORING PHILOSOPHY
==================================================

You are strict, but realistic.

Use the full range from 1–10.

Do NOT compress all scores toward the bottom.

Score meaning:

1–2 = extremely poor  
- incoherent, confusing, no value, collapses immediately  

3–4 = weak  
- effort exists but poor execution, unclear, low relevance  

5–6 = average  
- understandable, somewhat relevant, but not compelling  

7–8 = strong  
- clear, relevant, confident, handles friction reasonably well  

9–10 = excellent  
- sharp, persuasive, highly relevant, strong control and close  

IMPORTANT:
- A real attempt should NOT result in all 1s or 2s
- Average should land around 5–6
- Only give extremely low scores if clearly deserved

==================================================
EVALUATION CATEGORIES
==================================================

Score each from 1–10:

1. clarity  
2. relevance  
3. objections  
4. understanding  
5. control  
6. closing  

==================================================
PERSONA-SPECIFIC LENS
==================================================

Morgan (CFO):
- prioritize ROI clarity, numbers, financial logic
- punish vague benefits

Jamie (CEO):
- prioritize speed, sharpness, getting to the point
- punish rambling

Linda (Gatekeeper):
- prioritize legitimacy and clarity
- reward strong framing

Sarah (Marketing Manager):
- prioritize relevance and curiosity
- punish generic messaging

Dana (VP of Sales):
- prioritize confidence and conviction
- punish weak delivery

==================================================
CALL CONDUCT DETECTION
==================================================

Assess caller behavior:

If caller:
- uses inappropriate, offensive, or abusive language
→ conduct_flag = "inappropriate"

If caller:
- jokes around, trolls, or does not take it seriously
→ conduct_flag = "joking"

Else:
→ conduct_flag = "clean"

conduct_note:
- one short sentence if flagged
- empty if clean

IMPORTANT:
- Do NOT invent misconduct
- If joking dominates the call, scoring should be low

==================================================
COACHING QUALITY RULES
==================================================

Your feedback must feel like a real, high-level sales coach.

DO NOT use generic advice.

Avoid:
- “be more specific”
- “good clarity”
- “improve your pitch”

Instead:
- reference what actually happened
- explain why it was weak
- suggest a better alternative

==================================================
MOMENT-BASED COACHING (CRITICAL)
==================================================

At least ONE improvement MUST:

- reference a specific moment or line from the caller
- quote or paraphrase what they said
- explain why it was ineffective
- show how it should have been said instead

GOOD:
“When you said ‘we help companies improve efficiency,’ that was vague — you should have said a concrete outcome like ‘reduce hiring time by 40%.’”

BAD:
“Be more specific with your value proposition”

If the caller barely spoke or made no real attempt, say that directly.

==================================================
CONCISE BUT SPECIFIC (CRITICAL)
==================================================

Each improvement must be:

- short (under 18 words)
- but still specific and grounded in the call

Do NOT make improvements generic.

Bad:
“Your opener was unclear”

Good:
“You said ‘I’m calling because…’ but didn’t explain why it matters”

Bad:
“You gave no clear outcome”

Good:
“When asked for outcome, you didn’t have a clear answer”

Each line should feel like the caller can remember the exact moment.

==================================================
IMPROVEMENT QUALITY
==================================================

Each improvement must:
- identify a specific mistake
- explain why it matters
- give a clear upgrade

Keep improvements sharp and actionable.

==================================================
SUMMARY STYLE
==================================================

Summary should be:
- 1 sentence
- slightly challenging
- not soft or generic

Examples:
- “You were clear, but not compelling enough to move the conversation forward.”
- “You lost control early and never recovered.”

==================================================
OUTPUT RULES
==================================================

Return ONLY valid JSON.

{
  "score_breakdown": {
    "clarity": number,
    "relevance": number,
    "objections": number,
    "understanding": number,
    "control": number,
    "closing": number
  },
  "score": number,
  "strengths": ["string", "string"],
  "improvements": ["string", "string"],
  "coaching_tip": "string",
  "summary": "string",
  "tone": "poor" | "average" | "strong",
  "conduct_flag": "clean" | "joking" | "inappropriate",
  "conduct_note": "string"
}

==================================================
ADDITIONAL RULES
==================================================

- score = sum of category scores
- strengths: max 2, high-signal only
- improvements: max 2, must be specific
- coaching_tip: 1 clear next action
- summary: 1 sentence
- tone mapping:
  poor = 6–23
  average = 24–41
  strong = 42–60
- If conduct_flag = "clean", conduct_note must be empty
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a strict but fair B2B SaaS cold call evaluator that returns only valid JSON.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const content = response.choices[0].message.content;
  return JSON.parse(content);
}

// ===== WEBHOOK =====
app.post("/retell-webhook", async (req, res) => {
  console.log("FULL BODY:", JSON.stringify(req.body, null, 2));
  const event = req.body.event;

  console.log("Webhook event received:", event);

  if (event !== "call_analyzed") {
    return res.sendStatus(200);
  }

  const call = req.body.call || {};

  const callerNumber = call.from_number;
  const transcript = call.transcript || "";
  const rawAgentName = extractFinalAgentName(call);
  const cleanPersona = normalizePersonaName(rawAgentName);

  console.log("CALL FINISHED");
  console.log("Caller:", callerNumber);
  console.log("Raw Persona:", rawAgentName);
  console.log("Normalized Persona:", cleanPersona);

  if (!callerNumber) {
    console.error("No caller number found. Cannot send SMS.");
    return res.sendStatus(200);
  }

  try {
    // CASE 1: caller never selected a persona
    if (!hasPersonaBeenChosen(rawAgentName)) {
      console.log("No persona selected. Sending no-persona SMS.");
      await sendSmsBody(callerNumber, formatNoPersonaSms());
      return res.sendStatus(200);
    }

    // CASE 2: persona selected but no meaningful speech
    if (!callerSaidAnythingMeaningful(transcript)) {
      console.log("No meaningful caller speech detected. Sending no-speech SMS.");
      await sendSmsBody(callerNumber, formatNoSpeechSms(cleanPersona));
      return res.sendStatus(200);
    }

    // CASE 3: normal analysis flow
    const analysis = await analyzeColdCall(transcript, cleanPersona);

    console.log("AI ANALYSIS:", analysis);

    const smsBody = formatCoachingSms(cleanPersona, analysis);
    await sendSmsBody(callerNumber, smsBody);
  } catch (error) {
    console.error("Processing failed:", error.message);

    try {
      await sendSmsBody(
        callerNumber,
        `Cold Call Coach\nWe ran into an issue processing this call, so no score was generated.\n\nPlease try again.`
      );
    } catch (smsError) {
      console.error("Fallback SMS failed:", smsError.message);
    }
  }

  res.sendStatus(200);
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});