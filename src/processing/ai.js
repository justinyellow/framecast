const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { toLines } = require('./transcribe');

let client = null;
// The SDK also resolves profiles and workload identity federation; any of these means credentials may exist.
const hasCredentials = () => ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID']
  .some((k) => process.env[k]);
const getClient = () => (client ||= new Anthropic());

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'chapters'],
  properties: {
    title: { type: 'string', description: 'Concise, specific title, max 70 characters.' },
    summary: { type: 'string', description: '2-4 sentence summary of what the video covers and any asks or decisions.' },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start_s', 'title'],
        properties: {
          start_s: { type: 'number', description: 'Chapter start in seconds, taken from the transcript timestamps.' },
          title: { type: 'string', description: 'Short chapter title, max 50 characters.' },
        },
      },
    },
  },
};

// Returns { title, summary, chapters: [{ s, title }] } on the source timeline, or null when AI is unavailable.
async function summarize(words, durationS) {
  if (!config.ai.enabled || !hasCredentials() || !words?.length) return null;
  const transcript = toLines(words, 30).map((l) => `[${fmt(l.s)} | ${l.s.toFixed(1)}s] ${l.text}`).join('\n');
  const chapterHint = durationS && durationS < 90
    ? 'The video is short: return at most 2 chapters, or none if it covers a single topic.'
    : 'Return 3-8 chapters at natural topic changes. The first chapter starts at the first spoken line.';

  const response = await getClient().beta.messages.create({
    model: config.ai.model,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: 'You write titles, summaries and chapter markers for screen-recorded work videos (product demos, code walkthroughs, bug reports, updates). Be specific and plain; do not invent details that are not in the transcript.',
    messages: [{ role: 'user', content: `${chapterHint}\n\nTranscript:\n${transcript}` }],
  });

  if (response.stop_reason === 'refusal') return null;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const data = JSON.parse(text);
  return {
    title: data.title.trim().slice(0, 120),
    summary: data.summary.trim(),
    chapters: data.chapters
      .filter((c) => Number.isFinite(c.start_s) && c.title)
      .map((c) => ({ s: Math.max(0, c.start_s), title: c.title.trim().slice(0, 80) }))
      .sort((a, b) => a.s - b.s),
  };
}

module.exports = { summarize, hasCredentials };
