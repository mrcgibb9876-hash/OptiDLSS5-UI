// Game Help, tier two: when no rule fits, the same evidence the support bundle carries goes to
// Claude, which may only act through the fixes tier one already has -- each one confirmed by
// the user before it runs -- and must end with a plain verdict: fixed, or DLSS 5 is not
// currently available for this game, and why.
//
// Opt-in, on the user's own Anthropic API key (they pay Anthropic directly; this app has no
// account of its own). The key is kept in settings.json with the rest of the settings and is
// sent to api.anthropic.com only. Nothing is sent unless the user presses Ask AI.

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5';
const MODELS = ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-5'];

const SYSTEM = `You are Game Help inside OptiDLSS5-UI, a Windows app that installs OptiScaler with the DLSS 5 Neural Rendering (NR) model into games, plus the DLSS5 Feeder (a ReShade add-on that synthesises a DLSS call for games with no DLSS of their own) or Luma UE (which replaces an Unreal Engine 4 game's TAA with DLAA so there is a DLSS call to hook).
You are given the app's own view of one game (detection, route, what is deployed, the last run's verdict) and the tails of its logs. Work out why DLSS 5 Neural Rendering is not running in gameplay and fix it if you can.
You can only act through the apply_fix tool, whose fixes are the ones the app can do safely; the user confirms each one before it runs. Never ask for files, never suggest manual edits unless nothing else remains, and do not speculate about hardware you cannot see.
When you are done, call finish. If the game cannot run DLSS 5 with what this app can deploy, say so plainly: "DLSS 5 is not currently available for this game" plus the reason. Keep every message under 120 words.`;

const TOOLS = [
  {
    name: 'apply_fix',
    description: 'Run one of the app\'s own fixes on this game. remove-foreign: remove another DLSS 5 toolchain\'s files (DLSS5-Swapper, oneclick). remove-feeder: remove the DLSS5 Feeder stack. remove-luma: remove the Luma UE stack. reconfigure: re-run the app\'s automatic configuration (OptiScaler.ini upscaler keys incl. dlss_12 for D3D11, NR enabled, REFramework for RE Engine, ReShade ini). install: run the card\'s Install for the recommended route (OptiScaler, Feeder or Luma as the route says). Returns what happened.',
    input_schema: {
      type: 'object',
      properties: {
        fix: { type: 'string', enum: ['remove-foreign', 'remove-feeder', 'remove-luma', 'reconfigure', 'install'] },
        why: { type: 'string', description: 'One sentence for the user, shown before they confirm.' },
      },
      required: ['fix', 'why'],
    },
  },
  {
    name: 'finish',
    description: 'End the session with a verdict for the user.',
    input_schema: {
      type: 'object',
      properties: {
        available: { type: 'boolean', description: 'true if DLSS 5 can work here after what was done; false if it is not currently available for this game.' },
        summary: { type: 'string', description: 'What was found, what was done, and what the user should do next (launch the game and reach gameplay to confirm, or nothing). Under 120 words.' },
      },
      required: ['available', 'summary'],
    },
  },
];

async function callClaude({ apiKey, model, messages, fetchImpl = fetch }) {
  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Runs the loop. `applyFix(fix, why)` is the app's: it asks the user, runs the fix, and returns
// a text result (or a refusal). `onText(text)` receives Claude's prose as it comes.
async function helpSession({ apiKey, model = DEFAULT_MODEL, evidence, applyFix, onText = () => {}, fetchImpl = fetch, maxTurns = 6 }) {
  const transcript = [];
  const messages = [{ role: 'user', content: `Here is the app's evidence for this game:\n\n${evidence}` }];
  for (let turn = 0; turn < maxTurns; turn++) {
    const reply = await callClaude({ apiKey, model, messages, fetchImpl });
    const content = reply.content || [];
    for (const block of content) if (block.type === 'text' && block.text) { transcript.push({ role: 'assistant', text: block.text }); onText(block.text); }
    const uses = content.filter((b) => b.type === 'tool_use');
    if (!uses.length || reply.stop_reason === 'end_turn') {
      return { ok: true, available: null, summary: transcript.map((t) => t.text).join('\n\n'), transcript, turns: turn + 1 };
    }
    messages.push({ role: 'assistant', content });
    const results = [];
    for (const use of uses) {
      if (use.name === 'finish') {
        const { available, summary } = use.input || {};
        transcript.push({ role: 'assistant', text: summary || '' });
        return { ok: true, available: !!available, summary: summary || '', transcript, turns: turn + 1 };
      }
      if (use.name === 'apply_fix') {
        const { fix, why } = use.input || {};
        let result;
        try { result = await applyFix(fix, why || ''); } catch (e) { result = `failed: ${e && e.message ? e.message : e}`; }
        transcript.push({ role: 'tool', text: `${fix}: ${result}` });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: String(result) });
      } else {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'unknown tool', is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { ok: true, available: null, summary: transcript.filter((t) => t.role === 'assistant').map((t) => t.text).join('\n\n'), transcript, turns: maxTurns, truncated: true };
}

module.exports = { helpSession, callClaude, DEFAULT_MODEL, MODELS, TOOLS, SYSTEM };
