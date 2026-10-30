import { stripVTControlCharacters } from 'node:util';

const HIDDEN = /(?:\u2026|^\s*\.{3}\s*$|[↑↓]\d+|\bview all\b|\bsee (?:more|the first lines)\b|\b\d+ lines? (?:above|hidden|omitted)\b|\+\d+ lines?\b|cannot be shown|too large to (?:show|preview)|not previewed|could not be checked)/im;
const CLAUDE_HEADER = /^(?:Bash command(?: \([^\n]+\))?|Read file|Edit file|Overwrite file|Create file|Write file|Edit notebook)(?: · from (?:the .+ (?:agent|plugin)|a subagent|the ".+" workflow|a remote cloud agent))?$/;
const CODEX_HEADER = /^(?:Would you like to run the following command\?|Would you like to make the following edits\?)$/;

export function parsePrompt(agent, source) {
  if (!['claude', 'codex'].includes(agent) || typeof source !== 'string' || source.length > 24_000) return null;
  const text = stripVTControlCharacters(source).replaceAll('\r\n', '\n');
  if (/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(text)) return null;
  const rawLines = text.split('\n');
  const lines = rawLines.map((line) => line.trim());
  const header = agent === 'claude' ? CLAUDE_HEADER : CODEX_HEADER;
  const starts = lines.flatMap((line, i) => header.test(line) ? [i] : []);
  if (starts.length !== 1) return null;
  const start = starts[0];
  const body = lines.slice(start);
  const rows = body.flatMap((line, i) => {
    const match = /^(?:(❯|›|>)\s*)?(\d+)\.\s+(.+)$/.exec(line);
    return match ? [{ line: i, selected: Boolean(match[1]), number: Number(match[2]), label: match[3] }] : [];
  });
  if (rows.length < 2 || rows.length > 4 || rows.some((row, i) => row.number !== i + 1)) return null;
  const first = rows[0];
  const last = rows.at(-1);
  // Input fields and user navigation must not receive an approval shortcut.
  if (!first.selected || rows.slice(1).some((row) => row.selected)) return null;
  let keys;
  if (agent === 'codex') {
    const allow = /^(?:Yes, proceed|Yes, just this once) \(([a-z])\)$/.exec(first.label);
    if (!allow || !/^No, (?:and tell Codex|go back)/.test(last.label)) return null;
    if (!body.slice(1, first.line).some((line) => line.length > 0)) return null;
    if (body[0].includes('command') && !body.slice(1, first.line).some((line) => /^\$\s+\S/.test(line))) return null;
    if (rows.slice(1).some((row) => row.label.endsWith(`(${allow[1]})`))) return null;
    keys = [allow[1]];
  } else {
    if (first.label !== 'Yes' || last.label !== 'No') return null;
    const question = body.findIndex((line) => /^Do you want to (?:proceed|make this edit to .+|overwrite .+|create .+|write to .+|insert this cell into .+|delete this cell from .+)\?$/.test(line));
    if (question < 2 || question >= first.line || !body.slice(1, question).some(Boolean)) return null;
    keys = ['1'];
  }
  const footer = body.slice(last.line + 1).filter(Boolean).join('\n');
  if (!/esc.*cancel/i.test(footer) || /Select with numbers|Enter to submit/i.test(footer)) return null;
  // Reject a composer or another dialog below the permission menu.
  if (body.slice(last.line + 1).some((line) => /^[›❯>]\s+\S/.test(line))) return null;
  // Keep command indentation for classification. Remove only the dialog gutter.
  const gutter = rawLines[start].match(/^\s*/)[0];
  const request = rawLines.slice(start, start + first.line)
    .map((line) => (line.startsWith(gutter) ? line.slice(gutter.length) : line.trimStart()).replace(/\s+$/, ''))
    .join('\n');
  if (HIDDEN.test(request)) return null;
  return { agent, text: request, keys };
}
